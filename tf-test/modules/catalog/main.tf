data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["glue.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "crawler" {
  name               = "${var.name_prefix}-glue-crawler"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "glue_service" {
  role       = aws_iam_role.crawler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole"
}

data "aws_iam_policy_document" "crawler" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.raw_bucket_arn}/*"]
  }

  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.raw_bucket_arn]
  }

  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "crawler" {
  name   = "lake-read"
  role   = aws_iam_role.crawler.id
  policy = data.aws_iam_policy_document.crawler.json
}

# One crawler per source type (s3, db, api, stream, sftp); each sub-folder becomes a table.
resource "aws_glue_crawler" "raw" {
  for_each = toset(var.source_prefixes)

  name          = "${var.name_prefix}-raw-${each.key}"
  database_name = var.raw_database_name
  role          = aws_iam_role.crawler.arn
  schedule      = var.schedule
  table_prefix  = "${each.key}_"

  s3_target {
    path       = "s3://${var.raw_bucket_name}/${each.key}/"
    exclusions = ["**/_temporary/**", "**/errors/**", "**/*.metadata"]
  }

  recrawl_policy {
    recrawl_behavior = "CRAWL_NEW_FOLDERS_ONLY"
  }

  schema_change_policy {
    delete_behavior = "LOG"
    update_behavior = "LOG"
  }

  configuration = jsonencode({
    Version = 1.0
    Grouping = {
      TableGroupingPolicy = "CombineCompatibleSchemas"
      # Absolute folder depth of a table (bucket = 1): <type>/<source>/ or db/<source>/<schema>/<table>/
      TableLevelConfiguration = each.key == "db" ? 5 : 3
    }
    CrawlerOutput = {
      Partitions = { AddOrUpdateBehavior = "InheritFromTable" }
    }
  })
}
