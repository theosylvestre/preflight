variable "name_prefix" {
  type = string
}

variable "account_id" {
  type = string
}

variable "partition" {
  type = string
}

variable "snowflake_iam_user_arn" {
  type = string
}

variable "snowflake_external_id" {
  type = string
}

variable "snowpipe_sqs_arn" {
  type = string
}

variable "snowpipe_prefixes" {
  type = list(string)
}

variable "allow_write" {
  type = bool
}

variable "raw_bucket_name" {
  type = string
}

variable "raw_bucket_arn" {
  type = string
}

variable "curated_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  type = string
}
