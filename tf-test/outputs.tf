output "kms_key_arn" {
  description = "KMS key encrypting the data lake."
  value       = module.data_lake.kms_key_arn
}

output "raw_bucket" {
  description = "Raw (landing) zone bucket."
  value       = module.data_lake.raw_bucket_name
}

output "curated_bucket" {
  description = "Curated zone bucket."
  value       = module.data_lake.curated_bucket_name
}

output "artifacts_bucket" {
  description = "Bucket for code artifacts and Athena query results."
  value       = module.data_lake.artifacts_bucket_name
}

output "glue_databases" {
  description = "Glue Data Catalog databases."
  value = {
    raw     = module.data_lake.raw_glue_database_name
    curated = module.data_lake.curated_glue_database_name
  }
}

output "athena_workgroup" {
  description = "Athena workgroup to explore the lake."
  value       = module.data_lake.athena_workgroup_name
}

output "raw_layout" {
  description = "Where each source type lands in the raw bucket."
  value = {
    s3     = [for k, _ in var.s3_sources : "s3://${module.data_lake.raw_bucket_name}/s3/${k}/"]
    db     = [for k, _ in var.database_sources : "s3://${module.data_lake.raw_bucket_name}/db/${k}/"]
    api    = [for k, _ in var.api_sources : "s3://${module.data_lake.raw_bucket_name}/api/${k}/"]
    stream = [for k, _ in var.stream_sources : "s3://${module.data_lake.raw_bucket_name}/stream/${k}/"]
    sftp   = [for k, _ in var.sftp_users : "s3://${module.data_lake.raw_bucket_name}/sftp/${k}/"]
  }
}

output "s3_ingestion_role_arn" {
  description = "DataSync role — grant it s3:GetObject/ListBucket in cross-account source bucket policies."
  value       = try(module.ingestion_s3[0].role_arn, null)
}

output "dms_security_group_id" {
  description = "Security group used by DMS — allow it inbound on your source databases."
  value       = try(module.ingestion_database[0].security_group_id, null)
}

output "api_ingest_function_name" {
  description = "Lambda running API ingestions (invoke manually with {\"source\": \"<name>\"} to backfill)."
  value       = try(module.ingestion_api[0].function_name, null)
}

output "firehose_streams" {
  description = "Firehose delivery stream names by source."
  value       = try(module.ingestion_streaming[0].stream_names, {})
}

output "sftp_endpoint" {
  description = "SFTP endpoint hostname."
  value       = try(module.ingestion_sftp[0].endpoint, null)
}

output "snowflake_role_arn" {
  description = "Use as STORAGE_AWS_ROLE_ARN in the Snowflake storage integration."
  value       = module.snowflake_integration.role_arn
}

output "snowflake_setup_sql" {
  description = "SQL to run in Snowflake (as ACCOUNTADMIN) to wire the lake in."
  value       = module.snowflake_integration.setup_sql
}
