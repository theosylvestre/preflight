terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Uncomment and fill in to keep state remotely (recommended for anything beyond a sandbox).
  # backend "s3" {
  #   bucket       = "my-terraform-state-bucket"
  #   key          = "data-platform/terraform.tfstate"
  #   region       = "eu-west-1"
  #   use_lockfile = true
  #   encrypt      = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
