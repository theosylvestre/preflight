data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["transfer.amazonaws.com"]
    }
  }
}

################################################################################
# Server
################################################################################

resource "aws_iam_role" "logging" {
  name               = "${var.name_prefix}-sftp-logging"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "logging" {
  role       = aws_iam_role.logging.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSTransferLoggingAccess"
}

resource "aws_transfer_server" "this" {
  identity_provider_type = "SERVICE_MANAGED"
  endpoint_type          = "PUBLIC"
  protocols              = ["SFTP"]
  domain                 = "S3"
  security_policy_name   = "TransferSecurityPolicy-2024-01"
  logging_role           = aws_iam_role.logging.arn

  tags = { Name = "${var.name_prefix}-sftp" }
}

################################################################################
# Users — each one is chrooted to raw/sftp/<user>/
################################################################################

resource "aws_iam_role" "user" {
  name               = "${var.name_prefix}-sftp-user"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "user" {
  statement {
    sid       = "ListOwnFolder"
    actions   = ["s3:ListBucket"]
    resources = [var.raw_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["sftp/$${transfer:UserName}/*", "sftp/$${transfer:UserName}"]
    }
  }

  statement {
    sid = "ReadWriteOwnFolder"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:DeleteObject",
    ]
    resources = ["${var.raw_bucket_arn}/sftp/$${transfer:UserName}/*"]
  }

  statement {
    sid       = "Kms"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.raw_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "user" {
  name   = "sftp-user"
  role   = aws_iam_role.user.id
  policy = data.aws_iam_policy_document.user.json
}

resource "aws_transfer_user" "this" {
  for_each = var.users

  server_id           = aws_transfer_server.this.id
  user_name           = each.key
  role                = aws_iam_role.user.arn
  home_directory_type = "LOGICAL"

  home_directory_mappings {
    entry  = "/"
    target = "/${var.raw_bucket_name}/sftp/${each.key}"
  }
}

locals {
  user_keys = merge([
    for user, cfg in var.users : {
      for i, key in cfg.ssh_public_keys : "${user}-${i}" => { user = user, key = key }
    }
  ]...)
}

resource "aws_transfer_ssh_key" "this" {
  for_each = local.user_keys

  server_id = aws_transfer_server.this.id
  user_name = aws_transfer_user.this[each.value.user].user_name
  body      = each.value.key
}
