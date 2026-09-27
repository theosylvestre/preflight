output "role_arn" {
  value = aws_iam_role.snowflake.arn
}

output "bootstrapping" {
  description = "True while the trust policy still uses the placeholder (Snowflake values not yet provided)."
  value       = local.bootstrapping
}

output "setup_sql" {
  value = local.setup_sql
}
