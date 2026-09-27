# Offline (mocked) apply of the whole platform with every source type enabled.
# Run: terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:eu-west-1:123456789012:key/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-west-1:123456789012:function:mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:eu-west-1:123456789012:mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:eu-west-1:123456789012:parameter/mock" }
  }
  mock_resource "aws_kinesis_firehose_delivery_stream" {
    defaults = { arn = "arn:aws:firehose:eu-west-1:123456789012:deliverystream/mock" }
  }
  mock_resource "aws_datasync_location_s3" {
    defaults = { arn = "arn:aws:datasync:eu-west-1:123456789012:location/loc-mock" }
  }
  mock_resource "aws_transfer_server" {
    defaults = { id = "s-0123456789abcdef0", endpoint = "s-0123456789abcdef0.server.transfer.eu-west-1.amazonaws.com" }
  }
  mock_resource "aws_transfer_user" {
    defaults = { id = "s-0123456789abcdef0/supplier_a" }
  }
  mock_resource "aws_dms_endpoint" {
    defaults = { endpoint_arn = "arn:aws:dms:eu-west-1:123456789012:endpoint:mock" }
  }
  mock_resource "aws_dms_s3_endpoint" {
    defaults = { endpoint_arn = "arn:aws:dms:eu-west-1:123456789012:endpoint:mock-s3" }
  }
}

variables {
  project     = "acme"
  environment = "test"

  s3_sources = {
    partner = { bucket_name = "partner-bucket", include_patterns = ["/daily/*.csv"] }
  }

  database_sources = {
    crm_postgres = {
      engine        = "postgres"
      database_name = "crm"
      secret_arn    = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:crm-AbCdEf"
    }
  }

  api_sources = {
    github = {
      url        = "https://api.github.com/repos/hashicorp/terraform/issues"
      auth_type  = "bearer"
      secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:gh-AbCdEf"
      pagination = { type = "link_header", size_param = "per_page" }
    }
    rates = { url = "https://api.frankfurter.app/latest" }
  }

  stream_sources = { web_events = {} }

  sftp_users = {
    supplier_a = { ssh_public_keys = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKey supplier"] }
  }

  snowpipe_sqs_arn  = "arn:aws:sqs:eu-west-1:999999999999:sf-snowpipe-mock"
  snowpipe_prefixes = ["api/", "stream/"]
}

run "full_platform" {
  command = apply

  assert {
    condition     = length(module.ingestion_database) == 1 && length(module.network) == 1
    error_message = "DB ingestion should bring its own VPC."
  }

  assert {
    condition     = length(module.catalog[0].crawler_names) == 5
    error_message = "Expected one crawler per source type."
  }

  assert {
    condition     = output.snowflake_role_arn != null
    error_message = "Snowflake role must always exist."
  }
}

run "lake_only" {
  command = apply

  variables {
    s3_sources       = {}
    database_sources = {}
    api_sources      = {}
    stream_sources   = {}
    sftp_users       = {}
    snowpipe_sqs_arn = ""
  }

  assert {
    condition     = length(module.network) == 0 && length(module.catalog) == 0
    error_message = "No source => no VPC, no crawlers."
  }
}
