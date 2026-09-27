output "security_group_id" {
  value = aws_security_group.dms.id
}

output "replication_config_arns" {
  value = { for k, r in aws_dms_replication_config.this : k => r.arn }
}
