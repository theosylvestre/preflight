variable "name_prefix" {
  type = string
}

variable "users" {
  type = map(object({
    ssh_public_keys = list(string)
  }))
}

variable "raw_bucket_name" {
  type = string
}

variable "raw_bucket_arn" {
  type = string
}

variable "raw_kms_key_arn" {
  type = string
}
