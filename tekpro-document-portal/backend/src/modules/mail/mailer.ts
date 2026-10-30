import nodemailer from "nodemailer";
import type { Logger } from "pino";
import type { AppConfig } from "../../config/env.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

class SmtpMailer implements Mailer {
  readonly enabled = true;
  private transport;
  constructor(private readonly cfg: AppConfig["mail"]) {
    this.transport = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      requireTLS: !cfg.smtp.secure,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.password } : undefined,
    });
  }
  async send(m: MailMessage) {
    await this.transport.sendMail({ from: this.cfg.from, to: m.to, subject: m.subject, text: m.text });
  }
}

/**
 * Development-only mailer that prints messages to stdout so password links can
 * be followed locally. Configuration validation rejects it in production.
 */
class ConsoleMailer implements Mailer {
  readonly enabled = true;
  async send(m: MailMessage) {
    process.stdout.write(`\n----- [dev mail] to=${m.to} subject=${m.subject}\n${m.text}\n-----\n`);
  }
}

class DisabledMailer implements Mailer {
  readonly enabled = false;
  constructor(private readonly logger: Logger) {}
  async send(m: MailMessage) {
    this.logger.warn({ subject: m.subject }, "Mail delivery is disabled (MAIL_DRIVER=disabled); message not sent");
  }
}

/** Collects messages in memory; used by tests. */
export class RecordingMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
}

export function createMailer(cfg: AppConfig["mail"], logger: Logger): Mailer {
  switch (cfg.driver) {
    case "smtp":
      return new SmtpMailer(cfg);
    case "console":
      return new ConsoleMailer();
    default:
      return new DisabledMailer(logger);
  }
}
