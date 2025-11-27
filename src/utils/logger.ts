import {ChalkInstance} from "chalk";

export enum LogLevel {
    error = 0,
    warn = 1,
    info = 2,
    debug = 3,
}

// Global log level - can be set via setLogLevel()
let currentLogLevel: LogLevel = LogLevel.info;

export const setLogLevel = (level: LogLevel | string) => {
    if (typeof level === "string") {
        const parsed = LogLevel[level.toLowerCase() as keyof typeof LogLevel];
        if (parsed !== undefined) {
            currentLogLevel = parsed;
        } else {
            console.warn(`Invalid log level: ${level}. Using 'info'.`);
            currentLogLevel = LogLevel.info;
        }
    } else {
        currentLogLevel = level;
    }
};

export const getLogLevel = () => currentLogLevel;

export type Logger = {
    error: (msg: string, ...optionalParams: unknown[]) => void;
    warn: (msg: string, ...optionalParams: unknown[]) => void;
    info: (msg: string, ...optionalParams: unknown[]) => void;
    debug: (msg: string, ...optionalParams: unknown[]) => void;
};

export const getLogger = (prefix: string, chalk: ChalkInstance): Logger => ({
    error: (msg: string, ...optionalParams: unknown[]) => {
        if (currentLogLevel >= LogLevel.error) {
            console.error(`${chalk.bold.red(`[${prefix}]`)} ${chalk.red(msg)}`, ...optionalParams);
        }
    },
    warn: (msg: string, ...optionalParams: unknown[]) => {
        if (currentLogLevel >= LogLevel.warn) {
            console.warn(`${chalk.bold.yellow(`[${prefix}]`)} ${chalk.yellow(msg)}`, ...optionalParams);
        }
    },
    info: (msg: string, ...optionalParams: unknown[]) => {
        if (currentLogLevel >= LogLevel.info) {
            console.info(`${chalk.bold(`[${prefix}]`)} ${chalk(msg)}`, ...optionalParams);
        }
    },
    debug: (msg: string, ...optionalParams: unknown[]) => {
        if (currentLogLevel >= LogLevel.debug) {
            console.debug(`${chalk.bold.gray(`[${prefix}]`)} ${chalk.gray(msg)}`, ...optionalParams);
        }
    }
});
