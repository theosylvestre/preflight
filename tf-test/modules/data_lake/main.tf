################################################################################
# KMS
################################################################################

data "aws_iam_policy_document" "kms" {
  # Delegate key usage to IAM policies in this account (ingestion roles, Snowflake role...).
  statement {
    sid       = "EnableIAMPolicies"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "lake" {
  description             = "${var.name_prefix} data lake encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "lake" {
  name          = "alias/${var.name_prefix}-lake"
  target_key_id = aws_kms_key.lake.key_id
}

################################################################################
# Buckets
################################################################################

locals {
  # logs bucket must use SSE-S3: S3 server access logging does not support SSE-KMS targets.
  buckets = {
    raw       = { kms = true, versioning = true }
    curated   = { kms = true, versioning = true }
    artifacts = { kms = true, versioning = true }
    logs      = { kms = false, versioning = false }
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket        = "${var.name_prefix}-${each.key}-${var.account_id}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = { for k, v in aws_s3_bucket.this : k => v if local.buckets[k].versioning }
  bucket   = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.buckets[each.key].kms ? "aws:kms" : "AES256"
      kms_master_key_id = local.buckets[each.key].kms ? aws_kms_key.lake.arn : null
    }
    bucket_key_enabled = local.buckets[each.key].kms
  }
}

resource "aws_s3_bucket_logging" "this" {
  for_each = { for k, v in aws_s3_bucket.this : k => v if k != "logs" }
  bucket   = each.value.id

  target_bucket = aws_s3_bucket.this["logs"].id
  target_prefix = "s3-access/${each.key}/"
}

data "aws_iam_policy_document" "bucket" {
  for_each = aws_s3_bucket.this

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "AllowS3ServerAccessLogs"
      actions   = ["s3:PutObject"]
      resources = ["${each.value.arn}/s3-access/*"]
      principals {
        type        = "Service"
        identifiers = ["logging.s3.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [var.account_id]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.this["raw"].id

  rule {
    id     = "tiering"
    status = "Enabled"
    filter {}

    transition {
      days          = var.raw_transition_to_ia_days
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = var.raw_transition_to_glacier_days
      storage_class = "GLACIER_IR"
    }

    dynamic "expiration" {
      for_each = var.raw_expiration_days > 0 ? [1] : []
      content {
        days = var.raw_expiration_days
      }
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "housekeeping" {
  for_each = toset(["curated", "artifacts"])
  bucket   = aws_s3_bucket.this[each.key].id

  rule {
    id     = "housekeeping"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = each.key == "artifacts" ? [1] : []
    content {
      id     = "athena-results"
      status = "Enabled"
      filter {
        prefix = "athena-results/"
      }
      expiration {
        days = 30
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.this["logs"].id

  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}

    expiration {
      days = 365
    }
  }
}

################################################################################
# Glue Data Catalog + Athena
################################################################################

resource "aws_glue_catalog_database" "raw" {
  name        = replace("${var.name_prefix}_raw", "-", "_")
  description = "Raw zone — data as landed from sources."
}

resource "aws_glue_catalog_database" "curated" {
  name        = replace("${var.name_prefix}_curated", "-", "_")
  description = "Curated zone — cleaned, conformed datasets."
}

resource "aws_athena_workgroup" "lake" {
  name          = "${var.name_prefix}-lake"
  force_destroy = true

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.this["artifacts"].bucket}/athena-results/"

      encryption_configuration {
        encryption_option = "SSE_KMS"
        kms_key_arn       = aws_kms_key.lake.arn
      }
    }
  }
}
