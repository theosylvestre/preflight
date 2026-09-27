variable "name_prefix" {
  type = string
}

variable "sources" {
  type = map(object({
    url                 = string
    method              = string
    schedule_expression = string
    headers             = map(string)
    query_params        = map(string)
    body                = optional(string)
    auth_type           = string
    api_key_header      = string
    secret_arn          = optional(string)
    records_path        = optional(string)
    pagination = object({
      type        = string
      param       = string
      size_param  = optional(string)
      size        = number
      start       = optional(number)
      cursor_path = optional(string)
      max_pages   = number
    })
    enabled = bool
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
