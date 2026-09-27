// Maps a Terraform AWS resource type (aws_s3_bucket, aws_glue_job…)
// to the service icon from the official AWS pack stored in media/aws-icons.

const fs = require('fs');
const path = require('path');

// Type prefix (without "aws_") → service icon name (Arch_<name>_64.svg).
// The longest prefix wins: "s3control" before "s3", "route53" before "route".
const SERVICES = {
	acm: 'AWS-Certificate-Manager',
	acmpca: 'AWS-Private-Certificate-Authority',
	alb: 'Elastic-Load-Balancing',
	ami: 'Amazon-EC2',
	amplify: 'AWS-Amplify',
	api_gateway: 'Amazon-API-Gateway',
	apigatewayv2: 'Amazon-API-Gateway',
	appautoscaling: 'AWS-Application-Auto-Scaling',
	appconfig: 'AWS-AppConfig',
	appsync: 'AWS-AppSync',
	athena: 'Amazon-Athena',
	autoscaling: 'Amazon-EC2-Auto-Scaling',
	backup: 'AWS-Backup',
	batch: 'AWS-Batch',
	bedrock: 'Amazon-Bedrock',
	bedrockagent: 'Amazon-Bedrock',
	budgets: 'AWS-Budgets',
	cloudformation: 'AWS-CloudFormation',
	cloudfront: 'Amazon-CloudFront',
	cloudtrail: 'AWS-CloudTrail',
	cloudwatch: 'Amazon-CloudWatch',
	cloudwatch_event: 'Amazon-EventBridge',
	codeartifact: 'AWS-CodeArtifact',
	codebuild: 'AWS-CodeBuild',
	codecommit: 'AWS-CodeCommit',
	codedeploy: 'AWS-CodeDeploy',
	codepipeline: 'AWS-CodePipeline',
	cognito: 'Amazon-Cognito',
	config: 'AWS-Config',
	customer_gateway: 'AWS-Site-to-Site-VPN',
	datasync: 'AWS-DataSync',
	db: 'Amazon-RDS',
	default: 'Amazon-Virtual-Private-Cloud',
	detective: 'Amazon-Detective',
	directory_service: 'AWS-Directory-Service',
	dms: 'AWS-Database-Migration-Service',
	docdb: 'Amazon-DocumentDB',
	dx: 'AWS-Direct-Connect',
	dynamodb: 'Amazon-DynamoDB',
	ebs: 'Amazon-Elastic-Block-Store',
	ec2: 'Amazon-EC2',
	ec2_transit_gateway: 'AWS-Transit-Gateway',
	ecr: 'Amazon-Elastic-Container-Registry',
	ecs: 'Amazon-Elastic-Container-Service',
	efs: 'Amazon-EFS',
	egress_only_internet_gateway: 'Amazon-Virtual-Private-Cloud',
	eip: 'Amazon-EC2',
	eks: 'Amazon-Elastic-Kubernetes-Service',
	elastic_beanstalk: 'AWS-Elastic-Beanstalk',
	elasticache: 'Amazon-ElastiCache',
	elasticsearch: 'Amazon-OpenSearch-Service',
	elb: 'Elastic-Load-Balancing',
	emr: 'Amazon-EMR',
	emrserverless: 'Amazon-EMR',
	fsx: 'Amazon-FSx',
	glacier: 'Amazon-Simple-Storage-Service-Glacier',
	globalaccelerator: 'AWS-Global-Accelerator',
	glue: 'AWS-Glue',
	grafana: 'Amazon-Managed-Grafana',
	guardduty: 'Amazon-GuardDuty',
	iam: 'AWS-Identity-and-Access-Management',
	identitystore: 'AWS-IAM-Identity-Center',
	inspector2: 'Amazon-Inspector',
	instance: 'Amazon-EC2',
	internet_gateway: 'Amazon-Virtual-Private-Cloud',
	iot: 'AWS-IoT-Core',
	kendra: 'Amazon-Kendra',
	key_pair: 'Amazon-EC2',
	keyspaces: 'Amazon-Keyspaces',
	kinesis: 'Amazon-Kinesis-Data-Streams',
	kinesis_firehose: 'Amazon-Data-Firehose',
	kms: 'AWS-Key-Management-Service',
	lakeformation: 'AWS-Lake-Formation',
	lambda: 'AWS-Lambda',
	launch_configuration: 'Amazon-EC2-Auto-Scaling',
	launch_template: 'Amazon-EC2',
	lb: 'Elastic-Load-Balancing',
	lightsail: 'Amazon-Lightsail',
	macie2: 'Amazon-Macie',
	main_route_table_association: 'Amazon-Virtual-Private-Cloud',
	memorydb: 'Amazon-MemoryDB',
	mq: 'Amazon-MQ',
	msk: 'Amazon-Managed-Streaming-for-Apache-Kafka',
	mwaa: 'Amazon-Managed-Workflows-for-Apache-Airflow',
	nat_gateway: 'Amazon-Virtual-Private-Cloud',
	neptune: 'Amazon-Neptune',
	network_acl: 'Amazon-Virtual-Private-Cloud',
	network_interface: 'Amazon-Virtual-Private-Cloud',
	networkfirewall: 'AWS-Network-Firewall',
	opensearch: 'Amazon-OpenSearch-Service',
	opensearchserverless: 'Amazon-OpenSearch-Service',
	organizations: 'AWS-Organizations',
	pipes: 'Amazon-EventBridge',
	placement_group: 'Amazon-EC2',
	prometheus: 'Amazon-Managed-Service-for-Prometheus',
	ram: 'AWS-Resource-Access-Manager',
	rds: 'Amazon-Aurora',
	redshift: 'Amazon-Redshift',
	redshiftserverless: 'Amazon-Redshift',
	route: 'Amazon-Virtual-Private-Cloud',
	route53: 'Amazon-Route-53',
	s3: 'Amazon-Simple-Storage-Service',
	s3control: 'Amazon-Simple-Storage-Service',
	s3outposts: 'Amazon-S3-on-Outposts',
	sagemaker: 'Amazon-SageMaker-AI',
	scheduler: 'Amazon-EventBridge',
	secretsmanager: 'AWS-Secrets-Manager',
	security_group: 'Amazon-Virtual-Private-Cloud',
	securityhub: 'AWS-Security-Hub',
	servicecatalog: 'AWS-Service-Catalog',
	servicediscovery: 'AWS-Cloud-Map',
	ses: 'Amazon-Simple-Email-Service',
	sesv2: 'Amazon-Simple-Email-Service',
	sfn: 'AWS-Step-Functions',
	shield: 'AWS-Shield',
	sns: 'Amazon-Simple-Notification-Service',
	spot: 'Amazon-EC2',
	sqs: 'Amazon-Simple-Queue-Service',
	ssm: 'AWS-Systems-Manager',
	sso: 'AWS-IAM-Identity-Center',
	ssoadmin: 'AWS-IAM-Identity-Center',
	subnet: 'Amazon-Virtual-Private-Cloud',
	timestreamwrite: 'Amazon-Timestream',
	transfer: 'AWS-Transfer-Family',
	volume_attachment: 'Amazon-Elastic-Block-Store',
	vpc: 'Amazon-Virtual-Private-Cloud',
	vpc_lattice: 'Amazon-VPC-Lattice',
	vpn: 'AWS-Site-to-Site-VPN',
	waf: 'AWS-WAF',
	wafregional: 'AWS-WAF',
	wafv2: 'AWS-WAF',
	xray: 'AWS-X-Ray'
};

const KEYS = Object.keys(SERVICES).sort((a, b) => b.length - a.length);

/**
 * Indexes the 64 px service icons: service name → path relative to media/.
 * The pack folder is dated (Architecture-Service-Icons_MMDDYYYY), so it is matched by prefix.
 * @param {string} mediaDir
 */
function indexIcons(mediaDir) {
	const index = new Map();
	const root = path.join(mediaDir, 'aws-icons');
	let packs;
	try {
		packs = fs.readdirSync(root).filter((d) => d.startsWith('Architecture-Service-Icons'));
	} catch {
		return index;
	}
	for (const pack of packs) {
		for (const cat of fs.readdirSync(path.join(root, pack))) {
			const dir = path.join(root, pack, cat, '64');
			if (!fs.existsSync(dir)) continue;
			for (const f of fs.readdirSync(dir)) {
				const m = /^Arch_(.+)_64\.svg$/.exec(f);
				if (m) index.set(m[1], ['aws-icons', pack, cat, '64', f].join('/'));
			}
		}
	}
	return index;
}

// AWS console categories (icon pack folders) → display names.
const CATEGORY_LABELS = {
	'Security-Identity': 'Security, Identity & Compliance',
	'Networking-Content-Delivery': 'Networking & Content Delivery',
	'Application-Integration': 'Application Integration',
	'Management-Tools': 'Management & Governance',
	'Front-End-Web-Mobile': 'Front-End Web & Mobile',
	'Migration-Modernization': 'Migration & Modernization',
	'Artificial-Intelligence': 'Artificial Intelligence',
	'Cloud-Financial-Management': 'Cloud Financial Management',
	'Internet-of-Things': 'Internet of Things',
	'End-User-Computing': 'End User Computing'
};

/** Category slug of a service icon path (…/Arch_<Category>/64/…), or null. */
function categoryOf(rel) {
	const m = /\/Arch_([^/]+)\/64\//.exec(rel || '');
	return m ? m[1] : null;
}

function categoryLabel(slug) {
	return CATEGORY_LABELS[slug] || slug.replace(/-/g, ' ');
}

/**
 * Category icons (Arch-Category_<Category>_64.svg): slug → path relative to media/.
 * @param {string} mediaDir
 */
function indexCategoryIcons(mediaDir) {
	const index = new Map();
	const root = path.join(mediaDir, 'aws-icons');
	try {
		for (const pack of fs.readdirSync(root).filter((d) => d.startsWith('Category-Icons'))) {
			const dir = path.join(root, pack, 'Arch-Category_64');
			for (const f of fs.readdirSync(dir)) {
				const m = /^Arch-Category_(.+)_64\.svg$/.exec(f);
				if (m) index.set(m[1], ['aws-icons', pack, 'Arch-Category_64', f].join('/'));
			}
		}
	} catch {
		/* no category icons */
	}
	return index;
}

/** AWS service name for a Terraform resource type, or null. */
function serviceFor(type) {
	if (!type || !type.startsWith('aws_')) return null;
	const rest = type.slice(4);
	const key = KEYS.find((k) => rest === k || rest.startsWith(k + '_'));
	return key ? SERVICES[key] : null;
}

module.exports = { indexIcons, indexCategoryIcons, categoryOf, categoryLabel, serviceFor, SERVICES };
