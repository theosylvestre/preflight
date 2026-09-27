################################################################################
# Account-level DMS service roles (fixed names required by DMS — create once per account)
################################################################################

data "aws_iam_policy_document" "dms_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dms.amazonaws.com", "dms.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dms_vpc" {
  count              = var.create_dms_service_roles ? 1 : 0
  name               = "dms-vpc-role"
  assume_role_policy = data.aws_iam_policy_document.dms_assume.json
}

resource "aws_iam_role_policy_attachment" "dms_vpc" {
  count      = var.create_dms_service_roles ? 1 : 0
  role       = aws_iam_role.dms_vpc[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"
}

resource "aws_iam_role" "dms_logs" {
  count              = var.create_dms_service_roles ? 1 : 0
  name               = "dms-cloudwatch-logs-role"
  assume_role_policy = data.aws_iam_policy_document.dms_assume.json
}

resource "aws_iam_role_policy_attachment" "dms_logs" {
  count      = var.create_dms_service_roles ? 1 : 0
  role       = aws_iam_role.dms_logs[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole"
}

################################################################################
# Role used by endpoints: read DB secrets + write Parquet to the raw zone
################################################################################

resource "aws_iam_role" "dms" {
  name               = "${var.name_prefix}-dms"
  assume_role_policy = data.aws_iam_policy_document.dms_assume.json
}

locals {
  secret_arns     = distinct([for s in values(var.sources) : s.secret_arn])
  secret_kms_keys = compact(distinct([for s in values(var.sources) : s.secret_kms_key_arn]))
}

data "aws_iam_policy_document" "dms" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = local.secret_arns
  }

  dynamic "statement" {
    for_each = length(local.secret_kms_keys) > 0 ? [1] : []
    content {
      sid       = "DecryptSecrets"
      actions   = ["kms:Decrypt"]
      resources = local.secret_kms_keys
    }
  }

  statement {
    sid       = "RawBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.raw_bucket_arn]
  }

  statement {
    sid       = "RawObjects"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject", "s3:PutObjectTagging"]
    resources = ["${var.raw_bucket_arn}/db/*"]
  }

  statement {
    sid       = "RawKms"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.raw_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "dms" {
  name   = "db-ingestion"
  role   = aws_iam_role.dms.id
  policy = data.aws_iam_policy_document.dms.json
}

################################################################################
# Networking
################################################################################

resource "aws_dms_replication_subnet_group" "this" {
  replication_subnet_group_id          = "${var.name_prefix}-dms"
  replication_subnet_group_description = "${var.name_prefix} DMS serverless subnets"
  subnet_ids                           = var.subnet_ids

  depends_on = [aws_iam_role_policy_attachment.dms_vpc]
}

locals {
  egress_cidrs = distinct(flatten([
    for s in values(var.sources) : length(s.allowed_cidr_blocks) > 0 ? s.allowed_cidr_blocks : ["0.0.0.0/0"]
  ]))
}

resource "aws_security_group" "dms" {
  name        = "${var.name_prefix}-dms"
  description = "DMS serverless replications - allow this SG inbound on source databases"
  vpc_id      = var.vpc_id

  egress {
    description = "Source databases"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = local.egress_cidrs
  }

  egress {
    description = "HTTPS (S3 / Secrets Manager endpoints)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

################################################################################
# Endpoints & replications (one per source)
################################################################################

resource "aws_dms_endpoint" "source" {
  for_each = var.sources

  endpoint_id                     = "${var.name_prefix}-${replace(each.key, "_", "-")}-src"
  endpoint_type                   = "source"
  engine_name                     = each.value.engine
  database_name                   = each.value.database_name
  secrets_manager_arn             = each.value.secret_arn
  secrets_manager_access_role_arn = aws_iam_role.dms.arn
  ssl_mode                        = each.value.ssl_mode
  extra_connection_attributes     = each.value.extra_connection

  depends_on = [aws_iam_role_policy.dms]
}

resource "aws_dms_s3_endpoint" "target" {
  for_each = var.sources

  endpoint_id             = "${var.name_prefix}-${replace(each.key, "_", "-")}-raw"
  endpoint_type           = "target"
  bucket_name             = var.raw_bucket_name
  bucket_folder           = "db/${each.key}"
  service_access_role_arn = aws_iam_role.dms.arn

  # Parquet is loaded natively by Snowflake (COPY / INFER_SCHEMA / external tables).
  data_format                       = "parquet"
  parquet_version                   = "parquet-2-0"
  compression_type                  = "GZIP"
  parquet_timestamp_in_millisecond  = true
  include_op_for_full_load          = true
  timestamp_column_name             = "_dms_ingested_at"
  date_partition_enabled            = true
  date_partition_sequence           = "YYYYMMDD"
  cdc_max_batch_interval            = 60
  cdc_min_file_size                 = 32000
  encryption_mode                   = "SSE_KMS"
  server_side_encryption_kms_key_id = var.raw_kms_key_arn

  depends_on = [aws_iam_role_policy.dms]
}

locals {
  default_table_mappings = {
    for k, s in var.sources : k => jsonencode({
      rules = [
        for i, schema in s.include_schemas : {
          rule-type   = "selection"
          rule-id     = tostring(i + 1)
          rule-name   = "include-${i + 1}"
          rule-action = "include"
          object-locator = {
            schema-name = schema
            table-name  = "%"
          }
        }
      ]
    })
  }
}

resource "aws_dms_replication_config" "this" {
  for_each = var.sources

  replication_config_identifier = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  resource_identifier           = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  replication_type              = each.value.replication_type
  source_endpoint_arn           = aws_dms_endpoint.source[each.key].endpoint_arn
  target_endpoint_arn           = aws_dms_s3_endpoint.target[each.key].endpoint_arn
  table_mappings                = coalesce(each.value.table_mappings, local.default_table_mappings[each.key])
  start_replication             = each.value.start_replication

  compute_config {
    replication_subnet_group_id = aws_dms_replication_subnet_group.this.replication_subnet_group_id
    vpc_security_group_ids      = [aws_security_group.dms.id]
    min_capacity_units          = each.value.min_capacity_units
    max_capacity_units          = each.value.max_capacity_units
    multi_az                    = false
  }

  depends_on = [aws_iam_role_policy_attachment.dms_logs]
}
