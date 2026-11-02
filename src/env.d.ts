type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	R2_ACCOUNT_ID?: string;
	R2_ANALYTICS_API_TOKEN?: string;
	MEDIA?: R2Bucket;
}

declare namespace App {
	interface Locals extends Runtime {}
}
