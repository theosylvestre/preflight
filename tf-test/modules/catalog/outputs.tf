output "crawler_names" {
  value = [for c in aws_glue_crawler.raw : c.name]
}
