#!/usr/bin/env bash
# Registers a new task definition with a given image and starts a CodeDeploy blue/green deployment, then waits.
#   ecs-deploy-blue-green.sh <deploy-config-json-file> <service> <image>
set -euo pipefail

config_file=$1
service=$2
image=$3

family=$(jq -r --arg s "$service" '.blueGreen[$s].family' "$config_file")
application=$(jq -r --arg s "$service" '.blueGreen[$s].application' "$config_file")
group=$(jq -r --arg s "$service" '.blueGreen[$s].group' "$config_file")
port=$(jq -r --arg s "$service" '.blueGreen[$s].port' "$config_file")

# Starts from the latest revision, so environment changes made by Terraform come along.
task_definition=$(
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg image "$image" --arg name "$service" '
      (.containerDefinitions[] | select(.name == $name) | .image) = $image
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)'
)
task_definition_arn=$(
  aws ecs register-task-definition --cli-input-json "$task_definition" \
    --query taskDefinition.taskDefinitionArn --output text
)

app_spec=$(
  jq -cn --arg td "$task_definition_arn" --arg name "$service" --argjson port "$port" '{
    version: 1,
    Resources: [{
      TargetService: {
        Type: "AWS::ECS::Service",
        Properties: {
          TaskDefinition: $td,
          LoadBalancerInfo: { ContainerName: $name, ContainerPort: $port }
        }
      }
    }]
  }'
)
revision=$(jq -cn --arg content "$app_spec" '{revisionType: "AppSpecContent", appSpecContent: {content: $content}}')

deployment_id=$(
  aws deploy create-deployment \
    --application-name "$application" \
    --deployment-group-name "$group" \
    --revision "$revision" \
    --description "${GITHUB_REF_NAME:-manual} ${GITHUB_SHA:-}" \
    --query deploymentId --output text
)
echo "CodeDeploy deployment $deployment_id for $service"

# `aws deploy wait` gives up after 30 minutes, which a canary plus the blue termination wait can exceed.
for _ in $(seq 1 240); do
  status=$(aws deploy get-deployment --deployment-id "$deployment_id" --query deploymentInfo.status --output text)
  case "$status" in
    Succeeded)
      echo "$service deployed"
      exit 0
      ;;
    Failed | Stopped)
      reason=$(aws deploy get-deployment --deployment-id "$deployment_id" --query deploymentInfo.errorInformation.message --output text)
      echo "::error::$service deployment $deployment_id ended as $status: $reason"
      exit 1
      ;;
  esac
  echo "$service: $status"
  sleep 15
done
echo "::error::$service deployment $deployment_id did not finish in an hour"
exit 1
