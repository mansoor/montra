data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ----- Execution role: what ECS itself needs to start a task --------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for secret in aws_secretsmanager_secret.this : secret.arn]
  }

  statement {
    sid       = "DecryptSecretsAndImages"
    actions   = ["kms:Decrypt"]
    resources = [var.ops_key_arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# ----- Task roles: what the code inside a task may do -----------------------------------------------------------------

resource "aws_iam_role" "task" {
  for_each = toset(["api", "worker", "doc-worker", "web", "kratos"])

  name               = "${var.name}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# The API and worker read and write files and use the field-encryption key (NFR-01).
data "aws_iam_policy_document" "api_and_worker" {
  statement {
    sid       = "Files"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.s3_bucket_arn}/*"]
  }

  statement {
    sid       = "ListFiles"
    actions   = ["s3:ListBucket"]
    resources = [var.s3_bucket_arn]
  }

  statement {
    sid       = "FileKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.storage_key_arn]
  }

  statement {
    sid       = "FieldEncryption"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.data_key_arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "files-and-keys"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.api_and_worker.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "files-and-keys"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.api_and_worker.json
}

# The doc worker only reads uploaded statements.
data "aws_iam_policy_document" "doc_worker" {
  statement {
    sid       = "ReadFiles"
    actions   = ["s3:GetObject"]
    resources = ["${var.s3_bucket_arn}/*"]
  }

  statement {
    sid       = "FileKey"
    actions   = ["kms:Decrypt"]
    resources = [var.storage_key_arn]
  }
}

resource "aws_iam_role_policy" "doc_worker" {
  name   = "read-files"
  role   = aws_iam_role.task["doc-worker"].id
  policy = data.aws_iam_policy_document.doc_worker.json
}

# The collector sidecar on API tasks writes embedded-metric logs, which CloudWatch turns into metrics.
data "aws_iam_policy_document" "collector" {
  statement {
    sid       = "EmbeddedMetricLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.metrics.arn}:*"]
  }
}

resource "aws_iam_role_policy" "collector" {
  name   = "publish-metrics"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.collector.json
}
