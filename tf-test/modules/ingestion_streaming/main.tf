data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name               = "${var.name_prefix}-firehose"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

locals {
  kinesis_arns = compact([for s in values(var.sources) : s.kinesis_stream_arn])
}

data "aws_iam_policy_document" "firehose" {
  statement {
    sid = "RawBucket"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      var.raw_bucket_arn,
      "${var.raw_bucket_arn}/stream/*",
      "${var.raw_bucket_arn}/errors/stream/*",
    ]
  }

  statement {
    sid       = "RawKms"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.raw_kms_key_arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.firehose.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(local.kinesis_arns) > 0 ? [1] : []
    content {
      sid = "ReadKinesis"
      actions = [
        "kinesis:DescribeStream",
        "kinesis:DescribeStreamSummary",
        "kinesis:GetShardIterator",
        "kinesis:GetRecords",
        "kinesis:ListShards",
      ]
      resources = local.kinesis_arns
    }
  }
}

resource "aws_iam_role_policy" "firehose" {
  name   = "stream-ingestion"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

resource "aws_cloudwatch_log_group" "firehose" {
  name              = "/aws/kinesisfirehose/${var.name_prefix}"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_stream" "firehose" {
  for_each       = var.sources
  name           = each.key
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

# Producers should send newline-delimited JSON so files load cleanly in Snowflake.
resource "aws_kinesis_firehose_delivery_stream" "this" {
  for_each = var.sources

  name        = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  destination = "extended_s3"

  dynamic "kinesis_source_configuration" {
    for_each = each.value.kinesis_stream_arn != null ? [1] : []
    content {
      kinesis_stream_arn = each.value.kinesis_stream_arn
      role_arn           = aws_iam_role.firehose.arn
    }
  }

  dynamic "server_side_encryption" {
    for_each = each.value.kinesis_stream_arn == null ? [1] : []
    content {
      enabled  = true
      key_type = "AWS_OWNED_CMK"
    }
  }

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose.arn
    bucket_arn          = var.raw_bucket_arn
    kms_key_arn         = var.raw_kms_key_arn
    compression_format  = "GZIP"
    buffering_size      = each.value.buffering_size_mb
    buffering_interval  = each.value.buffering_interval_secs
    prefix              = "stream/${each.key}/ingest_date=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/"
    error_output_prefix = "errors/stream/${each.key}/!{firehose:error-output-type}/ingest_date=!{timestamp:yyyy-MM-dd}/"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose[each.key].name
    }
  }

  depends_on = [aws_iam_role_policy.firehose]
}

################################################################################
# Producer role: attach to apps / EventBridge rules / CloudWatch Logs subscriptions
################################################################################

data "aws_iam_policy_document" "producer" {
  statement {
    actions   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = [for s in aws_kinesis_firehose_delivery_stream.this : s.arn]
  }
}

resource "aws_iam_policy" "producer" {
  name        = "${var.name_prefix}-stream-producer"
  description = "Allows writing to the data-platform Firehose streams."
  policy      = data.aws_iam_policy_document.producer.json
}
