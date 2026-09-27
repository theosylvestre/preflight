variable "name_prefix" {
  type = string
}

variable "account_id" {
  type = string
}

variable "force_destroy" {
  type = bool
}

variable "raw_transition_to_ia_days" {
  type = number
}

variable "raw_transition_to_glacier_days" {
  type = number
}

variable "raw_expiration_days" {
  type = number
}

variable "noncurrent_version_expiration_days" {
  type = number
}
