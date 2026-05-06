type LogContext = Record<string, unknown>;
type LogLevel = "debug" | "error" | "info" | "log" | "warn";

export class Logger {
	constructor(private scope: string) { }

	method(methodName: string, context?: LogContext) {
		this.log(`${methodName}()`, context);
	}

	debug(message: string, context?: LogContext) {
		this.write("debug", message, context);
	}

	error(message: string, error?: unknown, context?: LogContext) {
		this.write("error", message, context, error);
	}

	info(message: string, context?: LogContext) {
		this.write("info", message, context);
	}

	log(message: string, context?: LogContext) {
		this.write("log", message, context);
	}

	warn(message: string, error?: unknown, context?: LogContext) {
		this.write("warn", message, context, error);
	}

	private write(level: LogLevel, message: string, context?: LogContext, error?: unknown) {
		const prefix = `[MySync:${this.scope}] ${message}`;
		const args: unknown[] = context ? [prefix, context] : [prefix];

		if (error !== undefined) {
			args.push(error);
		}

		console[level](...args);
	}
}
