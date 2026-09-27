################################################################################
# IAM role assumed by the Snowflake storage integration
#
# Bootstrap: on the first apply Snowflake's IAM user / external ID are unknown, so the
# role trusts this account with a placeholder external ID. Create the integration in
# Snowflake, run DESC INTEGRATION, set the two variables and apply again.
################################################################################

locals {
  bootstrapping = var.snowflake_iam_user_arn == "" || var.snowflake_external_id == ""
  trusted_arn   = local.bootstrapping ? "arn:${var.partition}:iam::${var.account_id}:root" : var.snowflake_iam_user_arn
  external_id   = local.bootstrapping ? "bootstrap-placeholder" : var.snowflake_external_id
  role_name     = "${var.name_prefix}-snowflake-integration"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [local.trusted_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [local.external_id]
    }
  }
}

resource "aws_iam_role" "snowflake" {
  name                 = local.role_name
  description          = "Assumed by Snowflake storage integration to read the data lake."
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 43200
}

data "aws_iam_policy_document" "access" {
  statement {
    sid       = "ListLake"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.raw_bucket_arn, var.curated_bucket_arn]
  }

  statement {
    sid       = "ReadLake"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${var.raw_bucket_arn}/*", "${var.curated_bucket_arn}/*"]
  }

  dynamic "statement" {
    for_each = var.allow_write ? [1] : []
    content {
      sid       = "UnloadToCurated"
      actions   = ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = ["${var.curated_bucket_arn}/*"]
    }
  }

  statement {
    sid       = "Kms"
    actions   = var.allow_write ? ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey", "kms:Encrypt"] : ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "snowflake" {
  name   = "lake-access"
  role   = aws_iam_role.snowflake.id
  policy = data.aws_iam_policy_document.access.json
}

################################################################################
# Raw bucket notifications: Snowpipe auto-ingest (SQS) + EventBridge for anything else
################################################################################

resource "aws_s3_bucket_notification" "raw" {
  bucket      = var.raw_bucket_name
  eventbridge = true

  dynamic "queue" {
    for_each = var.snowpipe_sqs_arn != "" ? toset(var.snowpipe_prefixes) : toset([])
    content {
      id            = "snowpipe-${queue.value == "" ? "all" : trimsuffix(replace(queue.value, "/", "-"), "-")}"
      queue_arn     = var.snowpipe_sqs_arn
      events        = ["s3:ObjectCreated:*"]
      filter_prefix = queue.value == "" ? null : queue.value
    }
  }
}

################################################################################
# Ready-to-run Snowflake SQL
################################################################################

locals {
  integration_name = upper(replace("${var.name_prefix}_s3_lake", "-", "_"))

  setup_sql = <<-SQL
    -- 1. Storage integration (run as ACCOUNTADMIN)
    CREATE STORAGE INTEGRATION IF NOT EXISTS ${local.integration_name}
      TYPE = EXTERNAL_STAGE
      STORAGE_PROVIDER = 'S3'
      ENABLED = TRUE
      STORAGE_AWS_ROLE_ARN = '${aws_iam_role.snowflake.arn}'
      STORAGE_ALLOWED_LOCATIONS = ('s3://${var.raw_bucket_name}/', 's3://${trimprefix(var.curated_bucket_arn, "arn:${var.partition}:s3:::")}/');

    -- 2. Copy STORAGE_AWS_IAM_USER_ARN and STORAGE_AWS_EXTERNAL_ID into terraform.tfvars
    --    (snowflake_iam_user_arn / snowflake_external_id), then `terraform apply` again.
    DESC INTEGRATION ${local.integration_name};

    -- 3. File formats & stages
    CREATE FILE FORMAT IF NOT EXISTS FF_JSON    TYPE = JSON    COMPRESSION = AUTO;
    CREATE FILE FORMAT IF NOT EXISTS FF_PARQUET TYPE = PARQUET USE_LOGICAL_TYPE = TRUE;
    CREATE FILE FORMAT IF NOT EXISTS FF_CSV     TYPE = CSV     PARSE_HEADER = TRUE FIELD_OPTIONALLY_ENCLOSED_BY = '"';

    CREATE STAGE IF NOT EXISTS RAW_API    URL = 's3://${var.raw_bucket_name}/api/'    STORAGE_INTEGRATION = ${local.integration_name} FILE_FORMAT = FF_JSON;
    CREATE STAGE IF NOT EXISTS RAW_STREAM URL = 's3://${var.raw_bucket_name}/stream/' STORAGE_INTEGRATION = ${local.integration_name} FILE_FORMAT = FF_JSON;
    CREATE STAGE IF NOT EXISTS RAW_DB     URL = 's3://${var.raw_bucket_name}/db/'     STORAGE_INTEGRATION = ${local.integration_name} FILE_FORMAT = FF_PARQUET;
    CREATE STAGE IF NOT EXISTS RAW_S3     URL = 's3://${var.raw_bucket_name}/s3/'     STORAGE_INTEGRATION = ${local.integration_name};
    CREATE STAGE IF NOT EXISTS RAW_SFTP   URL = 's3://${var.raw_bucket_name}/sftp/'   STORAGE_INTEGRATION = ${local.integration_name};

    -- 4. Example auto-ingest pipe (API source). SHOW PIPES -> notification_channel = snowpipe_sqs_arn
    -- CREATE TABLE RAW.API_EXAMPLE (payload VARIANT, file_name STRING, loaded_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP());
    -- CREATE PIPE RAW.API_EXAMPLE_PIPE AUTO_INGEST = TRUE AS
    --   COPY INTO RAW.API_EXAMPLE (payload, file_name)
    --   FROM (SELECT $1, METADATA$FILENAME FROM @RAW_API/example/);
    --
    -- Parquet from DMS (schema inferred):
    -- CREATE TABLE RAW.CRM_CUSTOMERS USING TEMPLATE (
    --   SELECT ARRAY_AGG(OBJECT_CONSTRUCT(*)) FROM TABLE(INFER_SCHEMA(LOCATION => '@RAW_DB/crm_postgres/public/customers/', FILE_FORMAT => 'FF_PARQUET')));
    -- COPY INTO RAW.CRM_CUSTOMERS FROM @RAW_DB/crm_postgres/public/customers/ MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE;
  SQL
}
