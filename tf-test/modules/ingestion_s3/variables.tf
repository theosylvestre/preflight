variable "name_prefix" {
  type = string
}

variable "sources" {
  type = map(object({
    bucket_name         = string
    prefix              = string
    schedule_expression = string
    include_patterns    = list(string)
    exclude_patterns    = list(string)
    kms_key_arn         = optional(string)
  }))
}

variable "raw_bucket_arn" {
  type = string
}

variable "raw_kms_key_arn" {
  type = string
}
