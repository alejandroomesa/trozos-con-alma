type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

declare namespace App {
	interface Locals extends Runtime {}
}
