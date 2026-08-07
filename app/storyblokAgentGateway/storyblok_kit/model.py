from strands.models.bedrock import BedrockModel


def load_model() -> BedrockModel:
    """Get a native Bedrock Claude model client using the execution role's IAM credentials."""
    return BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        region_name="us-east-1",
    )
