output "kms_key_arn" {
  value = aws_kms_key.lake.arn
}

output "raw_bucket_name" {
  value = aws_s3_bucket.this["raw"].bucket
}

output "raw_bucket_arn" {
  value = aws_s3_bucket.this["raw"].arn
}

output "curated_bucket_name" {
  value = aws_s3_bucket.this["curated"].bucket
}

output "curated_bucket_arn" {
  value = aws_s3_bucket.this["curated"].arn
}

output "artifacts_bucket_name" {
  value = aws_s3_bucket.this["artifacts"].bucket
}

output "logs_bucket_name" {
  value = aws_s3_bucket.this["logs"].bucket
}

output "raw_glue_database_name" {
  value = aws_glue_catalog_database.raw.name
}

output "curated_glue_database_name" {
  value = aws_glue_catalog_database.curated.name
}

output "athena_workgroup_name" {
  value = aws_athena_workgroup.lake.name
}
