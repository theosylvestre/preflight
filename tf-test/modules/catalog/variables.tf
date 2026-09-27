variable "name_prefix" {
  type = string
}

variable "raw_bucket_name" {
  type = string
}

variable "raw_bucket_arn" {
  type = string
}

variable "raw_database_name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "source_prefixes" {
  type = list(string)
}

variable "schedule" {
  type = string
}
