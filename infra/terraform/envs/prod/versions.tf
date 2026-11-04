# One state per environment. The values are given at init time, so no account details live in the repository:
#   cp backend.hcl.example backend.hcl    # edit it; backend.hcl is git-ignored
#   terraform init -backend-config=backend.hcl
terraform {
  required_version = ">= 1.9"

  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.90"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}
