data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id

  tags = merge({
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Stack       = "data-platform"
  }, var.tags)

  needs_network = length(var.database_sources) > 0

  # Prefixes in the raw zone, one per source type actually in use. Drives Glue crawlers.
  raw_source_prefixes = compact([
    length(var.s3_sources) > 0 ? "s3" : "",
    length(var.database_sources) > 0 ? "db" : "",
    length(var.api_sources) > 0 ? "api" : "",
    length(var.stream_sources) > 0 ? "stream" : "",
    length(var.sftp_users) > 0 ? "sftp" : "",
  ])
}

################################################################################
# Core: KMS, buckets (raw / curated / artifacts / logs), Glue databases, Athena
################################################################################

module "data_lake" {
  source = "./modules/data_lake"

  name_prefix                        = local.name_prefix
  account_id                         = local.account_id
  force_destroy                      = var.force_destroy_buckets
  raw_transition_to_ia_days          = var.raw_transition_to_ia_days
  raw_transition_to_glacier_days     = var.raw_transition_to_glacier_days
  raw_expiration_days                = var.raw_expiration_days
  noncurrent_version_expiration_days = var.noncurrent_version_expiration_days
}

module "catalog" {
  source = "./modules/catalog"
  count  = var.enable_glue_crawlers && length(local.raw_source_prefixes) > 0 ? 1 : 0

  name_prefix       = local.name_prefix
  raw_bucket_name   = module.data_lake.raw_bucket_name
  raw_bucket_arn    = module.data_lake.raw_bucket_arn
  raw_database_name = module.data_lake.raw_glue_database_name
  kms_key_arn       = module.data_lake.kms_key_arn
  source_prefixes   = local.raw_source_prefixes
  schedule          = var.crawler_schedule
}

################################################################################
# Network (only when something needs to live in a VPC)
################################################################################

module "network" {
  source = "./modules/network"
  count  = local.needs_network && var.create_vpc ? 1 : 0

  name_prefix        = local.name_prefix
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  enable_nat_gateway = var.enable_nat_gateway
}

locals {
  vpc_id             = var.create_vpc ? try(module.network[0].vpc_id, null) : var.existing_vpc_id
  private_subnet_ids = var.create_vpc ? try(module.network[0].private_subnet_ids, []) : var.existing_private_subnet_ids
}

################################################################################
# Ingestion
################################################################################

# External S3 buckets -> raw/s3/<name>/ (AWS DataSync)
module "ingestion_s3" {
  source = "./modules/ingestion_s3"
  count  = length(var.s3_sources) > 0 ? 1 : 0

  name_prefix     = local.name_prefix
  sources         = var.s3_sources
  raw_bucket_arn  = module.data_lake.raw_bucket_arn
  raw_kms_key_arn = module.data_lake.kms_key_arn
}

# Relational databases -> raw/db/<name>/ as Parquet (AWS DMS Serverless, full load + CDC)
module "ingestion_database" {
  source = "./modules/ingestion_database"
  count  = length(var.database_sources) > 0 ? 1 : 0

  name_prefix              = local.name_prefix
  aws_region               = var.aws_region
  create_dms_service_roles = var.create_dms_service_roles
  sources                  = var.database_sources
  vpc_id                   = local.vpc_id
  subnet_ids               = local.private_subnet_ids
  raw_bucket_name          = module.data_lake.raw_bucket_name
  raw_bucket_arn           = module.data_lake.raw_bucket_arn
  raw_kms_key_arn          = module.data_lake.kms_key_arn
}

# REST APIs -> raw/api/<name>/ (Lambda + EventBridge Scheduler)
module "ingestion_api" {
  source = "./modules/ingestion_api"
  count  = length(var.api_sources) > 0 ? 1 : 0

  name_prefix     = local.name_prefix
  sources         = var.api_sources
  raw_bucket_name = module.data_lake.raw_bucket_name
  raw_bucket_arn  = module.data_lake.raw_bucket_arn
  raw_kms_key_arn = module.data_lake.kms_key_arn
}

# Events / streams -> raw/stream/<name>/ (Amazon Data Firehose)
module "ingestion_streaming" {
  source = "./modules/ingestion_streaming"
  count  = length(var.stream_sources) > 0 ? 1 : 0

  name_prefix     = local.name_prefix
  sources         = var.stream_sources
  raw_bucket_arn  = module.data_lake.raw_bucket_arn
  raw_kms_key_arn = module.data_lake.kms_key_arn
}

# Partner file drops -> raw/sftp/<user>/ (AWS Transfer Family)
module "ingestion_sftp" {
  source = "./modules/ingestion_sftp"
  count  = length(var.sftp_users) > 0 ? 1 : 0

  name_prefix     = local.name_prefix
  users           = var.sftp_users
  raw_bucket_name = module.data_lake.raw_bucket_name
  raw_bucket_arn  = module.data_lake.raw_bucket_arn
  raw_kms_key_arn = module.data_lake.kms_key_arn
}

################################################################################
# Snowflake: storage-integration IAM role + Snowpipe auto-ingest notifications
################################################################################

module "snowflake_integration" {
  source = "./modules/snowflake_integration"

  name_prefix            = local.name_prefix
  account_id             = local.account_id
  partition              = data.aws_partition.current.partition
  snowflake_iam_user_arn = var.snowflake_iam_user_arn
  snowflake_external_id  = var.snowflake_external_id
  snowpipe_sqs_arn       = var.snowpipe_sqs_arn
  snowpipe_prefixes      = var.snowpipe_prefixes
  allow_write            = var.snowflake_allow_write
  raw_bucket_name        = module.data_lake.raw_bucket_name
  raw_bucket_arn         = module.data_lake.raw_bucket_arn
  curated_bucket_arn     = module.data_lake.curated_bucket_arn
  kms_key_arn            = module.data_lake.kms_key_arn
}
