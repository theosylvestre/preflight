output "role_arn" {
  value = aws_iam_role.datasync.arn
}

output "task_arns" {
  value = { for k, t in aws_datasync_task.this : k => t.arn }
}
