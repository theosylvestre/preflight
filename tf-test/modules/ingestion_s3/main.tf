################################################################################
# IAM — one role used by DataSync for both source buckets and the raw bucket
################################################################################

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["datasync.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "datasync" {
  name               = "${var.name_prefix}-datasync"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

locals {
  source_bucket_arns = distinct([for s in values(var.sources) : "arn:aws:s3:::${s.bucket_name}"])
  source_kms_keys    = compact(distinct([for s in values(var.sources) : s.kms_key_arn]))
}

data "aws_iam_policy_document" "datasync" {
  statement {
    sid = "ReadSources"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]
    resources = local.source_bucket_arns
  }

  statement {
    sid = "ReadSourceObjects"
    actions = [
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:GetObjectVersion",
      "s3:GetObjectVersionTagging",
    ]
    resources = [for arn in local.source_bucket_arns : "${arn}/*"]
  }

  statement {
    sid = "WriteRawBucket"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [var.raw_bucket_arn]
  }

  statement {
    sid = "WriteRawObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
      "s3:PutObjectTagging",
    ]
    resources = ["${var.raw_bucket_arn}/s3/*"]
  }

  statement {
    sid       = "RawKms"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = concat([var.raw_kms_key_arn], local.source_kms_keys)
  }
}

resource "aws_iam_role_policy" "datasync" {
  name   = "s3-ingestion"
  role   = aws_iam_role.datasync.id
  policy = data.aws_iam_policy_document.datasync.json
}

################################################################################
# Logging
################################################################################

resource "aws_cloudwatch_log_group" "datasync" {
  name              = "/aws/datasync/${var.name_prefix}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "logs" {
  statement {
    actions   = ["logs:PutLogEvents", "logs:CreateLogStream"]
    resources = ["${aws_cloudwatch_log_group.datasync.arn}:*"]
    principals {
      type        = "Service"
      identifiers = ["datasync.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "datasync" {
  policy_name     = "${var.name_prefix}-datasync"
  policy_document = data.aws_iam_policy_document.logs.json
}

################################################################################
# Locations & tasks
################################################################################

resource "aws_datasync_location_s3" "source" {
  for_each = var.sources

  s3_bucket_arn = "arn:aws:s3:::${each.value.bucket_name}"
  subdirectory  = each.value.prefix

  s3_config {
    bucket_access_role_arn = aws_iam_role.datasync.arn
  }

  depends_on = [aws_iam_role_policy.datasync]
}

resource "aws_datasync_location_s3" "raw" {
  for_each = var.sources

  s3_bucket_arn = var.raw_bucket_arn
  subdirectory  = "/s3/${each.key}/"

  s3_config {
    bucket_access_role_arn = aws_iam_role.datasync.arn
  }

  depends_on = [aws_iam_role_policy.datasync]
}

resource "aws_datasync_task" "this" {
  for_each = var.sources

  name                     = "${var.name_prefix}-s3-${each.key}"
  source_location_arn      = aws_datasync_location_s3.source[each.key].arn
  destination_location_arn = aws_datasync_location_s3.raw[each.key].arn
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.datasync.arn

  schedule {
    schedule_expression = each.value.schedule_expression
  }

  options {
    transfer_mode          = "CHANGED"
    verify_mode            = "ONLY_FILES_TRANSFERRED"
    overwrite_mode         = "ALWAYS"
    preserve_deleted_files = "PRESERVE" # never delete from the lake when the source deletes
    posix_permissions      = "NONE"
    uid                    = "NONE"
    gid                    = "NONE"
    log_level              = "TRANSFER"
    object_tags            = "PRESERVE"
  }

  dynamic "includes" {
    for_each = length(each.value.include_patterns) > 0 ? [1] : []
    content {
      filter_type = "SIMPLE_PATTERN"
      value       = join("|", each.value.include_patterns)
    }
  }

  dynamic "excludes" {
    for_each = length(each.value.exclude_patterns) > 0 ? [1] : []
    content {
      filter_type = "SIMPLE_PATTERN"
      value       = join("|", each.value.exclude_patterns)
    }
  }

  depends_on = [aws_cloudwatch_log_resource_policy.datasync]
}
