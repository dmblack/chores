// The signing helper uses the maintained AWS SDK without its default credential chain.
module fortheherd.net/tasks/signer

go 1.27.4

require (
	github.com/aws/aws-sdk-go-v2 v1.48.0
	github.com/aws/aws-sdk-go-v2/credentials v1.21.1
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.20.9
)

require github.com/aws/smithy-go v1.28.9 // indirect
