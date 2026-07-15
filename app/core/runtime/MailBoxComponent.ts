import { Component } from "./entities";
import { component } from "./metadata";
import type { MailboxType } from "./types";

@component()
export class MailBoxComponent extends Component<[MailboxType]> {
  private mailboxType: MailboxType = "ordered";

  get MailboxType(): MailboxType {
    return this.mailboxType;
  }

  protected override Awake(mailboxType: MailboxType): void {
    this.mailboxType = mailboxType;
  }
}
