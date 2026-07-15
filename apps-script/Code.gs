/**
 * Wildfire Alerts Canada - inbound email command relay.
 *
 * Paste this into a new project at https://script.google.com, then:
 *   1. File > Project properties > Script properties, add:
 *        WORKER_URL          = https://<your-worker>.workers.dev
 *        API_SHARED_SECRET   = <same secret you set with `wrangler secret put API_SHARED_SECRET`>
 *   2. Triggers (clock icon) > Add trigger > checkForCommands > Time-driven
 *      > Minutes timer > Every 5 minutes.
 *
 * Send yourself an email with subject "FIRE: PAUSE ALL", "FIRE: Kelowna BC",
 * "FIRE: STATUS", etc. The "FIRE:" prefix is required so ordinary email
 * never gets misread as a command.
 */
function checkForCommands() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty("WORKER_URL");
  var sharedSecret = props.getProperty("API_SHARED_SECRET");
  if (!workerUrl || !sharedSecret) {
    Logger.log("Missing WORKER_URL or API_SHARED_SECRET script property.");
    return;
  }

  var threads = GmailApp.search('is:unread subject:"FIRE:"', 0, 20);
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];
      if (!message.isUnread()) continue;

      var subject = message.getSubject();
      var idx = subject.toUpperCase().indexOf("FIRE:");
      var commandText = idx >= 0 ? subject.substring(idx + 5).trim() : "";

      try {
        var response = UrlFetchApp.fetch(workerUrl + "/email-command", {
          method: "post",
          contentType: "application/json",
          headers: { Authorization: "Bearer " + sharedSecret },
          payload: JSON.stringify({ text: commandText }),
          muteHttpExceptions: true,
        });
        Logger.log("Command '" + commandText + "' -> " + response.getContentText());
      } catch (err) {
        Logger.log("Failed to relay command: " + err);
      }

      message.markRead();
    }
  }
}
