/**
 * Google Sheets Gmail Mail Merge
 *
 * This script adds a custom "Mail Merge" menu to a Google Sheet and uses a
 * Gmail draft as the email template for sending personalised messages.
 *
 * Expected Google Sheet structure:
 *
 *   Column A: First Name
 *   Column B: Last Name
 *   Column C: Email
 *   Column D: Status
 *
 * The first row must contain headers. Recipient data starts from row 2.
 *
 * Setup:
 *
 * 1. Create or open a Google Sheet with the columns:
 *
 *      First Name | Last Name | Email
 *
 * 2. Open the Apps Script editor from:
 *
 *      Extensions > Apps Script
 *
 * 3. Paste this script into the Apps Script editor and save it.
 *
 * 4. Create a Gmail draft to use as the email template.
 *
 *    The subject line of the draft must exactly match the subject line you
 *    enter when running the mail merge.
 *
 * 5. In the Gmail draft body, use the placeholder:
 *
 *      FIRSTNAME
 *
 *    The script replaces this placeholder with the value from the
 *    "First Name" column for each recipient.
 *
 * 6. Reload the Google Sheet.
 *
 *    A new "Mail Merge" menu will appear in the spreadsheet UI.
 *
 * 7. Select:
 *
 *      Mail Merge > Send Emails
 *
 *    Then enter the exact subject line of the Gmail draft you want to use.
 *
 * 8. The script sends one email per row and writes the send status to
 *    Column D.
 *
 * Required permissions:
 *
 * - Read Gmail drafts
 * - Send email through Gmail
 * - Read and update the active Google Sheet
 *
 * Notes:
 *
 * - The Gmail draft is matched by exact subject line.
 * - The email body is sent as HTML using the draft's HTML body.
 * - Only the first occurrence of FIRSTNAME is replaced unless the replacement
 *   logic is changed to use a global replacement.
 * - Empty or invalid recipient rows may cause send errors, which are written
 *   to the Status column.
 */


// constants
const PLACEHOLDER = 'FIRSTNAME';


// add 'Mail Merge' button to Spreadsheet UI
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("Mail Merge").addItem("Send Emails", "handler").addToUi();
}


function fetchDraftSubjectLine() {
  subject_line = Browser.inputBox(
    "Mail Merge",
    "Type or copy/paste the subject line of the Gmail " +
    "draft message you would like to mail merge with:",
    Browser.Buttons.OK_CANCEL
  );
  if (subject_line === "cancel" || subject_line === "") {
    return;
  }
  return subject_line;
}


function handler(subject_line) {

  // GET TEMPLATE
  subject_line = fetchDraftSubjectLine();
  if (!subject_line) {
    throw new Error("Draft email subject line should not be empty.");
    return;
  }
  let template = getGmailTemplateFromDrafts(subject_line);
  if (!template) {
    throw new Error("Failed to retrieve template from draft.");
    return;
  }

  // GET RECIPIENTS
  let sheet = SpreadsheetApp.getActiveSheet();
  if (!sheet) {
    throw new Error("Failed to determine active sheet.");
  }
  const data_range = sheet.getDataRange();
  const data_values = data_range.getValues();
  const recipients = data_values.slice(1);
  
  sendEmails(template, recipients, subject_line);

}


function getGmailTemplateFromDrafts(subject_line) {
  const drafts = GmailApp.getDrafts();
  for (let draft of drafts) {
    if (draft.getMessage().getSubject() === subject_line) {
      return draft.getMessage().getBody();
    }
  }
}


function sendEmails(template, recipients, subject_line) {
  let status = null;
  let ctr = 1;
  Logger.log(recipients);
  Logger.log(typeof(Recipients));
  for (let recipient of recipients) {
    ctr += 1;
    let first_name = recipient[0];
    let email = recipient[2];
    let message = template.replace(PLACEHOLDER, first_name);
    try {
      GmailApp.sendEmail(email, subject_line, message, {htmlBody: message});
    } catch (e) {
      status = e.message;
    }
    if (!status) {
      status = 'sent';
    }
    Logger.log(status);
    SpreadsheetApp.getActiveSheet().getRange(ctr, 4).setValue(status);
  }
}
