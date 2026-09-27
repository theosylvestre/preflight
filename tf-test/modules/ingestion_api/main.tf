locals {
  config_prefix = "/${var.name_prefix}/api-sources"
  secret_arns   = compact(distinct([for s in values(var.sources) : s.secret_arn]))
}

################################################################################
# Source configuration (read by the Lambda at runtime)
################################################################################

resource "aws_ssm_parameter" "source" {
  for_each = var.sources

  name = "${local.config_prefix}/${each.key}"
  type = "String"
  tier = "Intelligent-Tiering"
  value = jsonencode({
    url            = each.value.url
    method         = each.value.method
    headers        = each.value.headers
    query_params   = each.value.query_params
    body           = each.value.body
    auth_type      = each.value.auth_type
    api_key_header = each.value.api_key_header
    secret_arn     = each.value.secret_arn
    records_path   = each.value.records_path
    pagination     = each.value.pagination
  })
}

################################################################################
# Lambda
################################################################################

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/src"
  output_path = "${path.module}/.build/api_ingest.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-api-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "WriteRaw"
    actions   = ["s3:PutObject"]
    resources = ["${var.raw_bucket_arn}/api/*"]
  }

  statement {
    sid       = "RawKms"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [var.raw_kms_key_arn]
  }

  statement {
    sid       = "ReadConfig"
    actions   = ["ssm:GetParameter"]
    resources = [for p in aws_ssm_parameter.source : p.arn]
  }

  statement {
    sid       = "FailureDestination"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "api-ingestion"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name_prefix}-api-ingest"
  retention_in_days = 30
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-api-ingest-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_function" "this" {
  function_name    = "${var.name_prefix}-api-ingest"
  role             = aws_iam_role.lambda.arn
  runtime          = "python3.13"
  handler          = "handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  architectures    = ["arm64"]
  timeout          = 900
  memory_size      = 512

  environment {
    variables = {
      RAW_BUCKET    = var.raw_bucket_name
      CONFIG_PREFIX = local.config_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.lambda_logs]
}

# Scheduler invokes asynchronously: function errors land in the DLQ after 2 retries.
resource "aws_lambda_function_event_invoke_config" "this" {
  function_name                = aws_lambda_function.this.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.dlq.arn
    }
  }

  depends_on = [aws_iam_role_policy.lambda]
}

################################################################################
# Schedules
################################################################################

resource "aws_scheduler_schedule_group" "this" {
  name = "${var.name_prefix}-api-ingest"
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-api-ingest-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.this.arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-api-ingest"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "source" {
  for_each = var.sources

  name       = replace(each.key, "_", "-")
  group_name = aws_scheduler_schedule_group.this.name
  state      = each.value.enabled ? "ENABLED" : "DISABLED"

  schedule_expression          = each.value.schedule_expression
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.this.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = each.key })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }

    dead_letter_config {
      arn = aws_sqs_queue.dlq.arn
    }
  }
}

################################################################################
# Alerting hook: failed invocations
################################################################################

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name_prefix}-api-ingest-errors"
  alarm_description   = "API ingestion Lambda failed (check logs for the source name)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.this.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
