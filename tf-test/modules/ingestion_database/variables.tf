variable "name_prefix" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "sources" {
  type = map(object({
    engine              = string
    database_name       = optional(string)
    secret_arn          = string
    secret_kms_key_arn  = optional(string)
    replication_type    = string
    table_mappings      = optional(string)
    include_schemas     = list(string)
    ssl_mode            = string
    extra_connection    = optional(string)
    min_capacity_units  = number
    max_capacity_units  = number
    start_replication   = bool
    allowed_cidr_blocks = list(string)
  }))
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
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

variable "create_dms_service_roles" {
  description = "Create the account-global dms-vpc-role and dms-cloudwatch-logs-role. Set false if they already exist."
  type        = bool
  default     = true
}
