################################################################################
# General
################################################################################

variable "project" {
  description = "Short project name, used as a prefix for every resource."
  type        = string
  default     = "dataplatform"

  validation {
    condition     = can(regex("^[a-z0-9-]{2,20}$", var.project))
    error_message = "project must be 2-20 chars of lowercase letters, digits or hyphens."
  }
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod...)."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region to deploy into. Should match your Snowflake account region to avoid egress costs."
  type        = string
  default     = "eu-west-1"
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}

################################################################################
# Network (needed by database ingestion; created only if at least one DB source exists)
################################################################################

variable "create_vpc" {
  description = "Create a dedicated VPC. Set to false to reuse an existing one via existing_vpc_id / existing_private_subnet_ids."
  type        = bool
  default     = true
}

variable "vpc_cidr" {
  description = "CIDR of the VPC created when create_vpc = true."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to spread private subnets across."
  type        = number
  default     = 2
}

variable "enable_nat_gateway" {
  description = "Create a NAT gateway so resources in private subnets can reach databases over the internet. Not needed if sources are reachable via peering/VPN/TGW."
  type        = bool
  default     = false
}

variable "existing_vpc_id" {
  description = "Existing VPC ID (used when create_vpc = false)."
  type        = string
  default     = null
}

variable "existing_private_subnet_ids" {
  description = "Existing private subnet IDs (used when create_vpc = false). Need at least 2 AZs for DMS."
  type        = list(string)
  default     = []
}

################################################################################
# Data lake storage
################################################################################

variable "raw_transition_to_ia_days" {
  description = "Days before raw objects move to S3 Standard-IA."
  type        = number
  default     = 30
}

variable "raw_transition_to_glacier_days" {
  description = "Days before raw objects move to Glacier Instant Retrieval."
  type        = number
  default     = 180
}

variable "raw_expiration_days" {
  description = "Days before raw objects expire. 0 disables expiration."
  type        = number
  default     = 0
}

variable "noncurrent_version_expiration_days" {
  description = "Days before noncurrent object versions are deleted."
  type        = number
  default     = 30
}

variable "force_destroy_buckets" {
  description = "Allow terraform destroy to delete non-empty buckets. Keep false outside sandboxes."
  type        = bool
  default     = false
}

variable "enable_glue_crawlers" {
  description = "Create Glue crawlers that catalogue the raw zone (handy for Athena exploration and schema discovery)."
  type        = bool
  default     = true
}

variable "crawler_schedule" {
  description = "Cron schedule for Glue crawlers (AWS cron syntax)."
  type        = string
  default     = "cron(0 5 * * ? *)"
}

################################################################################
# Sources
################################################################################

variable "s3_sources" {
  description = <<-EOT
    External S3 buckets to copy into the raw zone with AWS DataSync.
    Key = source name (used in paths: raw/s3/<name>/).
    Cross-account buckets must grant the DataSync role (see output `s3_ingestion_role_arn`) read access in their bucket policy.
  EOT
  type = map(object({
    bucket_name         = string
    prefix              = optional(string, "/")
    schedule_expression = optional(string, "cron(0 2 * * ? *)")
    include_patterns    = optional(list(string), [])
    exclude_patterns    = optional(list(string), [])
    kms_key_arn         = optional(string) # KMS key protecting the source bucket, if any
  }))
  default = {}
}

variable "database_sources" {
  description = <<-EOT
    Relational databases replicated into the raw zone as Parquet with AWS DMS Serverless.
    Key = source name (raw/db/<name>/).
    secret_arn must point to a Secrets Manager secret with JSON keys: username, password, host, port (and dbname for postgres/oracle/sqlserver).
    engine: mysql | mariadb | postgres | aurora | aurora-postgresql | oracle | sqlserver
    replication_type: full-load | cdc | full-load-and-cdc
  EOT
  type = map(object({
    engine              = string
    database_name       = optional(string)
    secret_arn          = string
    secret_kms_key_arn  = optional(string)
    replication_type    = optional(string, "full-load-and-cdc")
    table_mappings      = optional(string) # raw DMS table-mapping JSON; defaults to include every table in every schema
    include_schemas     = optional(list(string), ["%"])
    ssl_mode            = optional(string, "require")
    extra_connection    = optional(string)
    min_capacity_units  = optional(number, 1)
    max_capacity_units  = optional(number, 4)
    start_replication   = optional(bool, false)
    allowed_cidr_blocks = optional(list(string), []) # egress CIDRs the DMS SG may reach; empty = anywhere
  }))
  default = {}

  validation {
    condition = alltrue([
      for s in values(var.database_sources) :
      contains(["mysql", "mariadb", "postgres", "aurora", "aurora-postgresql", "oracle", "sqlserver"], s.engine)
    ])
    error_message = "database_sources[*].engine must be one of mysql, mariadb, postgres, aurora, aurora-postgresql, oracle, sqlserver."
  }

  validation {
    condition = alltrue([
      for s in values(var.database_sources) :
      contains(["full-load", "cdc", "full-load-and-cdc"], s.replication_type)
    ])
    error_message = "database_sources[*].replication_type must be full-load, cdc or full-load-and-cdc."
  }
}

variable "create_dms_service_roles" {
  description = "Create the account-global `dms-vpc-role` and `dms-cloudwatch-logs-role`. Set false if they already exist in the account."
  type        = bool
  default     = true
}

variable "api_sources" {
  description = <<-EOT
    HTTP/REST APIs polled on a schedule by a generic Lambda and landed as gzipped JSON in raw/api/<name>/.
    auth_type: none | bearer | api_key | basic
      - bearer : secret JSON {"token": "..."}
      - api_key: secret JSON {"api_key": "..."} sent in header `api_key_header`
      - basic  : secret JSON {"username": "...", "password": "..."}
    pagination.type: none | page | offset | cursor | link_header
    For paginated APIs set records_path (or return a top-level array) so an empty page stops the loop.
  EOT
  type = map(object({
    url                 = string
    method              = optional(string, "GET")
    schedule_expression = optional(string, "rate(1 hour)")
    headers             = optional(map(string), {})
    query_params        = optional(map(string), {})
    body                = optional(string)
    auth_type           = optional(string, "none")
    api_key_header      = optional(string, "x-api-key")
    secret_arn          = optional(string)
    records_path        = optional(string) # dotted path to the array of records in the response, e.g. "data.items"
    pagination = optional(object({
      type        = optional(string, "none")
      param       = optional(string, "page") # page/offset/cursor query param name
      size_param  = optional(string)         # e.g. "per_page" / "limit"
      size        = optional(number, 100)
      start       = optional(number) # defaults to 1 (page) or 0 (offset)
      cursor_path = optional(string) # dotted path to next cursor in response body
      max_pages   = optional(number, 1000)
    }), {})
    enabled = optional(bool, true)
  }))
  default = {}

  validation {
    condition = alltrue([
      for s in values(var.api_sources) : contains(["none", "bearer", "api_key", "basic"], s.auth_type)
    ])
    error_message = "api_sources[*].auth_type must be none, bearer, api_key or basic."
  }
}

variable "stream_sources" {
  description = <<-EOT
    Streaming / event sources. Each entry creates a Firehose Direct-PUT stream landing into raw/stream/<name>/.
    Producers (apps, IoT, CloudWatch Logs subscriptions, EventBridge rules, Kinesis Data Streams...) push to it.
  EOT
  type = map(object({
    buffering_size_mb       = optional(number, 64)
    buffering_interval_secs = optional(number, 300)
    kinesis_stream_arn      = optional(string) # set to read from an existing Kinesis Data Stream instead of Direct PUT
  }))
  default = {}
}

variable "sftp_users" {
  description = <<-EOT
    Enables an AWS Transfer Family SFTP endpoint (partners/legacy file drops) when non-empty.
    Key = user name, landing in raw/sftp/<user>/. Note: the server costs ~$0.30/hour while it exists.
  EOT
  type = map(object({
    ssh_public_keys = list(string)
  }))
  default = {}
}

################################################################################
# Snowflake
################################################################################

variable "snowflake_iam_user_arn" {
  description = "STORAGE_AWS_IAM_USER_ARN from `DESC INTEGRATION <name>` in Snowflake. Leave empty on the first apply."
  type        = string
  default     = ""
}

variable "snowflake_external_id" {
  description = "STORAGE_AWS_EXTERNAL_ID from `DESC INTEGRATION <name>` in Snowflake. Leave empty on the first apply."
  type        = string
  default     = ""
}

variable "snowpipe_sqs_arn" {
  description = "notification_channel from `SHOW PIPES` / `DESC PIPE` (one SQS queue per Snowflake account & region). Enables S3 -> Snowpipe auto-ingest when set."
  type        = string
  default     = ""
}

variable "snowpipe_prefixes" {
  description = "Raw-zone prefixes that trigger Snowpipe notifications. Prefixes must not overlap. Empty string = whole bucket."
  type        = list(string)
  default     = [""]
}

variable "snowflake_allow_write" {
  description = "Grant Snowflake write access to the curated bucket (needed for COPY INTO @stage unloads)."
  type        = bool
  default     = false
}
