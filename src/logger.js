/**
 * logger with timestamps and colored output for the console
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function timestamp() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatPrefix(level, color) {
  return `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${color}[${level}]${COLORS.reset}`;
}

const logger = {
  info(msg) {
    console.log(`${formatPrefix('INFO', COLORS.cyan)} ${msg}`);
  },

  success(msg) {
    console.log(`${formatPrefix(' OK ', COLORS.green)} ${msg}`);
  },

  warn(msg) {
    console.warn(`${formatPrefix('WARN', COLORS.yellow)} ${msg}`);
  },

  error(msg) {
    console.error(`${formatPrefix(' ERR', COLORS.red)} ${msg}`);
  },

  /**
   * log specifically for forwarded messages
   */
  forwarded({ author, channel, preview }) {
    const text = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
    console.log(
      `${formatPrefix(' >> ', COLORS.magenta)} ` +
        `${COLORS.green}${author}${COLORS.reset} ` +
        `in ${COLORS.cyan}#${channel}${COLORS.reset}: ` +
        `${COLORS.dim}${text}${COLORS.reset}`
    );
  },
};

export default logger;
