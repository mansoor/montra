locals {
  default_tags = {
    Project     = "montra"
    Environment = "prod"
    ManagedBy   = "terraform"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.default_tags
  }
}

provider "aws" {
  alias  = "replica"
  region = var.replica_region

  default_tags {
    tags = local.default_tags
  }
}

# The separate backup account (BAK-02), in the primary region: one Aurora copy can't change both account and region.
provider "aws" {
  alias  = "backup_account"
  region = var.region

  assume_role {
    role_arn = "arn:aws:iam::${var.backup_account_id}:role/${var.backup_account_role_name}"
  }

  default_tags {
    tags = local.default_tags
  }
}

# The token comes from the CLOUDFLARE_API_TOKEN environment variable.
provider "cloudflare" {}
