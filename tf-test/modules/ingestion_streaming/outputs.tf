output "stream_names" {
  value = { for k, s in aws_kinesis_firehose_delivery_stream.this : k => s.name }
}

output "producer_policy_arn" {
  value = aws_iam_policy.producer.arn
}
