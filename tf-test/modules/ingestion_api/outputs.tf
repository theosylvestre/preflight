output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}
