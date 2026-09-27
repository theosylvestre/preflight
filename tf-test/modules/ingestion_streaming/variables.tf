variable "name_prefix" {
  type = string
}

variable "sources" {
  type = map(object({
    buffering_size_mb       = number
    buffering_interval_secs = number
    kinesis_stream_arn      = optional(string)
  }))
}

variable "raw_bucket_arn" {
  type = string
}

variable "raw_kms_key_arn" {
  type = string
}
