locals {
  default_tags = {
    Project     = "montra"
    Environment = "dev"
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

# Dev doesn't copy to a backup account, so this alias only satisfies the module's interface.
provider "aws" {
  alias  = "backup_account"
  region = var.region

  default_tags {
    tags = local.default_tags
  }
}

# The token comes from the CLOUDFLARE_API_TOKEN environment variable.
provider "cloudflare" {}
