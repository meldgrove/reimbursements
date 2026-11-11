"""German text for participants, by its English original.

tests/test_i18n.py checks that every text the app translates is here, with the same
placeholders.
"""

TEXT = {
    # Standard texts (portal.constants)
    "I confirm that the stated expenses were actually incurred, serve the stated purpose "
    "and have not been reimbursed before.": (
        "Hiermit bestätige ich, dass die angegebenen Auslagen tatsächlich entstanden sind, "
        "dem genannten Zweck dienen und bisher nicht erstattet wurden."
    ),
    "Your expenses. Simply submitted.": "Deine Auslagen. Einfach eingereicht.",
    "Submit the costs you paid out of your own pocket for reimbursement. "
    "Your details, receipts and signature are sent to accounting as a PDF.": (
        "Reiche deine privat ausgelegten Kosten zur Erstattung ein. "
        "Deine Angaben, Belege und Unterschrift werden als PDF an die Buchhaltung gesendet."
    ),
    "For questions about your claim or the payment, contact the address given in the form.": (
        "Bei Rückfragen oder Fragen zur Auszahlung wende dich an die Kontaktadresse im Formular."
    ),
    # Upload and limit messages (portal.intake)
    "The processed file is too large. Please export it at a lower resolution.": (
        "Die verarbeitete Datei ist zu groß. Bitte exportiere sie mit geringerer Auflösung."
    ),
    "The security check is temporarily unavailable. Please contact us.": (
        "Die Sicherheitsprüfung ist vorübergehend nicht verfügbar. Bitte kontaktiere uns."
    ),
    "Please upload a PDF, JPG or PNG file.": "Bitte lade eine PDF-, JPG- oder PNG-Datei hoch.",
    "The file could not be read. Please export it again.": (
        "Die Datei konnte nicht gelesen werden. Bitte exportiere sie erneut."
    ),
    "The PDF is password-protected. Please upload an unprotected copy.": (
        "Die PDF ist passwortgeschützt. Bitte lade eine ungeschützte Kopie hoch."
    ),
    "This PDF contains unsupported active content. Please export it as a plain PDF.": (
        "Diese PDF enthält nicht unterstützte aktive Inhalte. Bitte exportiere sie als "
        "einfache PDF."
    ),
    "The signature is empty. Please sign again.": (
        "Die Unterschrift ist leer. Bitte unterschreibe erneut."
    ),
    "The file did not pass the security check.": (
        "Die Datei hat die Sicherheitsprüfung nicht bestanden."
    ),
    "The security check is delayed. Please wait or try again later.": (
        "Die Sicherheitsprüfung ist verzögert. Bitte warte oder versuche es später erneut."
    ),
    "The file could not be checked. Please upload it again.": (
        "Die Datei konnte nicht geprüft werden. Bitte lade sie erneut hoch."
    ),
    "The file or request is too large.": "Die Datei oder Anfrage ist zu groß.",
    "Uploading is temporarily unavailable.": "Der Upload ist vorübergehend nicht verfügbar.",
    "Too many files were uploaded for this form. Please contact us.": (
        "Für dieses Formular wurden zu viele Dateien hochgeladen. Bitte kontaktiere uns."
    ),
    "Too many uploads from this network. Please try again later.": (
        "Zu viele Uploads aus diesem Netzwerk. Bitte versuche es später erneut."
    ),
    "The files need too much storage. Please remove files you do not need.": (
        "Die Dateien benötigen zu viel Speicher. Bitte entferne nicht benötigte Dateien."
    ),
    "Upload capacity is limited right now. Please wait a moment and try again.": (
        "Die Upload-Kapazität ist gerade begrenzt. Bitte warte kurz und versuche es erneut."
    ),
    "A PDF may have at most {count} pages.": "Eine PDF darf höchstens {count} Seiten enthalten.",
    "A receipt file may be at most {size}.": "Eine Belegdatei darf höchstens {size} groß sein.",
    "Each receipt file must be between 1 byte and {size}.": (
        "Jede Belegdatei muss zwischen 1 Byte und {size} groß sein."
    ),
    "The signature may be at most {size}.": "Die Unterschrift darf höchstens {size} groß sein.",
    "All receipts together may be at most {size}.": (
        "Alle Belege zusammen dürfen höchstens {size} groß sein."
    ),
    "All receipts together may have at most {count} pages.": (
        "Alle Belege zusammen dürfen höchstens {count} Seiten enthalten."
    ),
    "Please add 1 to {count} expense items.": "Bitte füge 1 bis {count} Auslagenpositionen hinzu.",
    "Each item needs 1 to {count} receipt files.": (
        "Jede Position benötigt 1 bis {count} Belegdateien."
    ),
    "Mileage allows at most {count} supporting files.": (
        "Für Kilometer sind höchstens {count} Nachweise erlaubt."
    ),
    "Each item allows at most {count} receipt files.": (
        "Pro Position sind höchstens {count} Belegdateien erlaubt."
    ),
    "PDF, JPG or PNG · up to {receipt} per file · {submission} in total · "
    "at most {pages} receipt pages": (
        "PDF, JPG oder PNG · bis {receipt} pro Datei · {submission} insgesamt · "
        "höchstens {pages} Belegseiten"
    ),
    "An invoice, receipt or ticket that shows the amount, purpose and business partner. "
    "More files are optional. Up to {count} files. You can change their order afterwards.": (
        "Eine Rechnung, Quittung oder ein Ticket, aus dem der Betrag, Zweck und "
        "Geschäftspartner hervorgehen. Weitere Dateien sind optional. Bis zu {count} Dateien. "
        "Die Reihenfolge kannst du anschließend ändern."
    ),
    "Sign with your finger, a pen or the mouse, or upload an image. JPG/PNG, at most {size}.": (
        "Mit Finger, Stift oder Maus unterschreiben oder ein Bild hochladen. "
        "JPG/PNG, höchstens {size}."
    ),
    "Enter the amount in euros without thousands separators, e.g. 12.50.": (
        "Betrag in Euro ohne Tausendertrennzeichen eingeben, z. B. 12,50."
    ),
    "Please enter a positive amount.": "Bitte gib einen positiven Betrag ein.",
    "Please enter the distance in whole kilometres.": (
        "Bitte gib die Entfernung in ganzen Kilometern ein."
    ),
    "The distance must be between 1 and {maximum} km.": (
        "Die Entfernung muss zwischen 1 und {maximum} km liegen."
    ),
    # The form script (portal.intake.script_text)
    "The session or file is no longer available. Please open the form again.": (
        "Die Sitzung oder Datei ist nicht mehr verfügbar. Bitte öffne das Formular erneut."
    ),
    "The request could not be processed.": "Die Anfrage konnte nicht verarbeitet werden.",
    "The connection was interrupted. Please try again.": (
        "Die Verbindung wurde unterbrochen. Bitte versuche es erneut."
    ),
    "The request failed.": "Die Anfrage ist fehlgeschlagen.",
    "Please fill in this field.": "Bitte fülle dieses Feld aus.",
    "Please enter a positive amount in euros, e.g. 12.50.": (
        "Bitte gib einen positiven Betrag in Euro ein, z. B. 12,50."
    ),
    "Please check the marked details.": "Bitte prüfe die markierten Angaben.",
    "The return date cannot be before the outward journey.": (
        "Das Rückfahrtdatum darf nicht vor der Hinfahrt liegen."
    ),
    "Total": "Summe",
    "Note: A receipt reference is used more than once. Please check the assignment.": (
        "Hinweis: Eine Belegreferenz wird mehrfach verwendet. Bitte prüfe die Zuordnung."
    ),
    "Add an expense with a receipt or a mileage claim.": (
        "Lege eine Auslage mit Beleg oder eine Kilometererstattung an."
    ),
    "Add an expense with a receipt.": "Lege eine Auslage mit Beleg an.",
    "Checked": "Geprüft",
    "Checking …": "Wird geprüft …",
    "Uploading …": "Wird hochgeladen …",
    "Check failed": "Prüfung fehlgeschlagen",
    "Move receipt up": "Beleg nach oben verschieben",
    "Move receipt down": "Beleg nach unten verschieben",
    "Remove": "Entfernen",
    "Check status again": "Status erneut prüfen",
    "Preview: uploading is not possible.": "Vorschau: Hochladen ist nicht möglich.",
    "Upload {percent} %": "Upload {percent} %",
    "The upload failed. Please try again.": (
        "Der Upload ist fehlgeschlagen. Bitte versuche es erneut."
    ),
    "The upload failed.": "Der Upload ist fehlgeschlagen.",
    "The upload was interrupted. Please try again.": (
        "Der Upload wurde unterbrochen. Bitte versuche es erneut."
    ),
    "The connection is slow. The check stays saved.": (
        "Die Verbindung ist verzögert. Die Prüfung bleibt gespeichert."
    ),
    "The check is taking longer. Please check the status again later; the file stays saved.": (
        "Die Prüfung dauert länger. Bitte prüfe den Status später erneut; "
        "die Datei bleibt gespeichert."
    ),
    "Uploading and checking the signature …": "Unterschrift wird hochgeladen und geprüft …",
    "Signature checked.": "Unterschrift geprüft.",
    "Signature checked: {name}": "Unterschrift geprüft: {name}",
    "Please clear the signature or try again.": (
        "Bitte lösche die Unterschrift oder versuche es erneut."
    ),
    "Signature drawn.": "Unterschrift gezeichnet.",
    "The signature changed. Please try again.": (
        "Die Unterschrift wurde geändert. Bitte versuche es erneut."
    ),
    "The signature is still being processed.": "Die Unterschrift wird noch verarbeitet.",
    "Please draw or upload a signature.": "Bitte zeichne oder lade eine Unterschrift hoch.",
    "Please sign or upload a signature.": "Bitte unterschreibe oder lade eine Unterschrift hoch.",
    "Please wait until the signature has been checked.": (
        "Bitte warte, bis die Unterschrift geprüft ist."
    ),
    "Each expense needs at least one receipt, and all files must be checked.": (
        "Jede Auslage benötigt mindestens einen Beleg, und alle Dateien müssen geprüft sein."
    ),
    "Please enter a positive amount in euros or a distance in whole kilometres for each item.": (
        "Bitte gib für jede Position einen positiven Betrag in Euro bzw. eine Entfernung in "
        "ganzen Kilometern ein."
    ),
    "Name": "Name",
    "Email": "E-Mail",
    "Street and house number": "Straße und Hausnummer",
    "Postcode": "PLZ",
    "Town or city": "Ort",
    "Country": "Land",
    "Account holder": "Kontoinhaber:in",
    "IBAN": "IBAN",
    "BIC": "BIC",
    "Occasion/project": "Anlass/Projektbezug",
    "Additional details": "Ergänzung",
    "Destination": "Zielort",
    "Trip start": "Reisebeginn",
    "Trip end": "Reiseende",
    "Trip {start} – {end}": "Fahrt {start} – {end}",
    "Trip {start} – {end} and back": "Fahrt {start} – {end} und zurück",
    "Outward: {date}": "Hinfahrt: {date}",
    "Return: {date}": "Rückfahrt: {date}",
    "Registration: {plate}": "Kennzeichen: {plate}",
    "Reference {reference}": "Referenz {reference}",
    "Total: {amount}": "Summe: {amount}",
    "Please confirm the declaration and the privacy notice.": (
        "Bitte bestätige die Erklärung und den Datenschutzhinweis."
    ),
    "Submitting …": "Wird eingereicht …",
    "Submit claim →": "Antrag einreichen →",
    # The claim form (portal.forms)
    "Please enter a five-digit postcode.": "Bitte gib eine fünfstellige Postleitzahl ein.",
    "Please enter a four-digit postcode.": "Bitte gib eine vierstellige Postleitzahl ein.",
    "Please enter the name using only letters, spaces, hyphens or apostrophes.": (
        "Bitte gib den Namen nur mit Buchstaben, Leerzeichen, Bindestrich oder Apostroph an."
    ),
    "First and last name": "Vorname Nachname",
    "Email address": "E-Mail-Adresse",
    "Occasion/connection to the project or event": (
        "Anlass/Bezug zum Projekt oder der Veranstaltung"
    ),
    "Additional details (optional)": "Ergänzung (optional)",
    "My expenses belong to a trip": "Meine Auslagen gehören zu einer Reise",
    "Confirm the declaration": "Erklärung bestätigen",
    "Privacy notice read": "Datenschutzhinweis gelesen",
    "Please enter a valid IBAN.": "Bitte gib eine gültige IBAN ein.",
    "Please enter a valid BIC with 8 or 11 characters.": (
        "Bitte gib eine gültige BIC mit 8 oder 11 Zeichen ein."
    ),
    "Please enter a valid postcode.": "Bitte gib eine gültige Postleitzahl ein.",
    "Accounts outside the SEPA area need a BIC.": (
        "Für Konten außerhalb des SEPA-Raums ist die BIC erforderlich."
    ),
    "Please enter the destination.": "Bitte gib den Zielort an.",
    "Please enter both trip dates.": "Bitte gib beide Reisedaten an.",
    "The trip cannot end before it starts.": (
        "Das Reiseende darf nicht vor dem Reisebeginn liegen."
    ),
    # Expense rules (portal.services.claim_validation)
    "Please enter the business partner.": "Bitte gib den Geschäftspartner an.",
    "Please enter the vehicle registration.": "Bitte gib das Kennzeichen des Fahrzeugs an.",
    "Please enter where the journey starts.": "Bitte gib den Startort der Fahrt an.",
    "Please enter the destination of the journey.": "Bitte gib das Ziel der Fahrt an.",
    "Invalid entry.": "Ungültige Angabe.",
    "Please enter the date of the journey.": "Bitte gib das Datum der Fahrt an.",
    "Invalid return journey entry.": "Ungültige Angabe zu Hin- und Rückfahrt.",
    "Please enter the return date.": "Bitte gib das Rückfahrtdatum an.",
    "The registration may have at most 20 characters.": (
        "Das Kennzeichen darf höchstens 20 Zeichen haben."
    ),
    "This type of item is not enabled for the form.": (
        "Diese Art von Position ist für das Formular nicht freigegeben."
    ),
    "Invalid receipt file.": "Ungültige Belegdatei.",
    "Invalid request.": "Ungültige Anfrage.",
    "Item {number}: invalid item ID.": "Position {number}: Ungültige Positionskennung.",
    "A receipt file can be assigned only once.": (
        "Eine Belegdatei darf nur einmal zugeordnet werden."
    ),
    "The total of all items is too high. Please check the amounts.": (
        "Die Summe aller Positionen ist zu hoch. Bitte prüfe die Beträge."
    ),
    # Drafts, uploads and submissions (portal.services)
    "This form has already been submitted.": "Dieses Formular wurde bereits eingereicht.",
    "The form was updated. Please reload it and check your details again.": (
        "Das Formular wurde aktualisiert. Bitte lade es neu und prüfe die Angaben erneut."
    ),
    "This form is closed for new claims.": "Dieses Formular ist für neue Anträge geschlossen.",
    "The form is currently unavailable.": "Das Formular ist derzeit nicht verfügbar.",
    "The form was not found.": "Das Formular wurde nicht gefunden.",
    "The form has expired. Please open the form again.": (
        "Das Formular ist abgelaufen. Bitte öffne das Formular erneut."
    ),
    "The form is busy right now. Please try again later.": (
        "Das Formular ist gerade ausgelastet. Bitte versuche es später erneut."
    ),
    "Too many new forms. Please try again later.": (
        "Zu viele neue Formulare. Bitte versuche es später erneut."
    ),
    "Too many new forms from this network. Please try again later.": (
        "Zu viele neue Formulare aus diesem Netzwerk. Bitte versuche es später erneut."
    ),
    "Please choose a receipt file or signature.": (
        "Bitte wähle eine Belegdatei oder Unterschrift aus."
    ),
    "The expense item is missing.": "Die Auslagenposition fehlt.",
    "Please remove an existing file first.": "Bitte entferne zuerst eine vorhandene Datei.",
    "The file is empty.": "Die Datei ist leer.",
    "The file was not found.": "Die Datei wurde nicht gefunden.",
    "Submitted receipts cannot be changed.": "Eingereichte Belege können nicht geändert werden.",
    "The file is being checked. Please try again shortly.": (
        "Die Datei wird gerade geprüft. Bitte versuche es kurz danach erneut."
    ),
    "Please wait until all receipts and the signature have been checked.": (
        "Bitte warte, bis alle Belege und die Unterschrift geprüft sind."
    ),
    "A file is unavailable. Please upload it again.": (
        "Eine Datei ist nicht verfügbar. Bitte lade sie erneut hoch."
    ),
    "A receipt does not belong to this expense item.": (
        "Ein Beleg gehört nicht zu dieser Auslagenposition."
    ),
    "This form has already been submitted with different details.": (
        "Dieses Formular wurde bereits mit anderen Angaben eingereicht."
    ),
    "Invalid item ID. Please open a new form.": (
        "Ungültige Positionskennung. Bitte öffne ein neues Formular."
    ),
    # The received page (portal.views)
    "Your claim is being processed and sent to Finance.": (
        "Dein Antrag wird verarbeitet und an Finance übermittelt."
    ),
    "There was a problem processing your claim. It stays saved; please do not submit it "
    "again, but contact us with your reference.": (
        "Bei der Verarbeitung ist ein Problem aufgetreten. Dein Antrag bleibt gespeichert; "
        "bitte reiche ihn nicht erneut ein, sondern melde dich mit deiner Referenz."
    ),
    "Your claim was sent to Finance.": "Dein Antrag wurde an Finance übermittelt.",
    "The status is unavailable right now. Your claim stays saved; please do not submit it again.": (
        "Der Status ist gerade nicht erreichbar. Dein Antrag bleibt gespeichert; bitte reiche "
        "ihn nicht erneut ein."
    ),
    "Reload this page later to check the current status.": (
        "Lade diese Seite später neu, um den aktuellen Status zu prüfen."
    ),
    # Emails (portal.services.confirmations, portal.services.delivery)
    "Confirmation of receipt: reimbursement claim {reference}": (
        "Eingangsbestätigung: Erstattungsantrag {reference}"
    ),
    "Hello {name},\n\n"
    "your reimbursement claim for {form} has been received.\n\n"
    "Your reference: {reference}\n"
    "Please quote this reference with any questions.\n\n"
    "This confirmation of receipt is not yet an approval of the reimbursement.\n"
    "{payment_timing}\n\n"
    "If you have questions, you can reach us at {support}.\n\n"
    "Best regards\nYour {app_name} team\n": (
        "Hallo {name},\n\n"
        "dein Erstattungsantrag für {form} ist eingegangen.\n\n"
        "Deine Referenz: {reference}\n"
        "Bitte gib diese Referenz bei Rückfragen an.\n\n"
        "Die Eingangsbestätigung ist noch keine Zusage zur Erstattung.\n"
        "{payment_timing}\n\n"
        "Bei Fragen erreichst du uns unter {support}.\n\n"
        "Viele Grüße\nDein Team von {app_name}\n"
    ),
    "Reimbursement claim {reference} | {form}": "Erstattungsantrag {reference} | {form}",
    "Reimbursement claim {reference}\nForm: {form}\n\n"
    "The complete reimbursement form and all receipts are in the attached PDF.\n": (
        "Erstattungsantrag {reference}\nFormular: {form}\n\n"
        "Das vollständige Erstattungsformular und alle Belege sind in der beigefügten PDF "
        "enthalten.\n"
    ),
    # Public pages (portal/templates/portal)
    "Reimbursement": "Erstattung",
    "Skip to content": "Zum Inhalt",
    "Legal notice": "Impressum",
    "Privacy": "Datenschutz",
    'Questions about your reimbursement? <a class="font-medium text-foreground '
    'hover:underline" href="mailto:{email}">{email}</a>': (
        'Fragen zur Erstattung? <a class="font-medium text-foreground hover:underline" '
        'href="mailto:{email}">{email}</a>'
    ),
    "Submit expenses": "Auslagen einreichen",
    "Here you can claim reimbursement of costs you paid out of your own pocket. Please open "
    "the link to your form that you received from your team.": (
        "Hier beantragst du die Erstattung von Kosten, die du privat verauslagt hast. Bitte "
        "öffne den Link zu deinem Formular, den du von deinem Team erhalten hast."
    ),
    "Form closed": "Formular geschlossen",
    "This reimbursement form is not accepting new claims at the moment. If you have "
    "questions, please contact the contact given.": (
        "Dieses Erstattungsformular nimmt derzeit keine neuen Anträge an. Bitte wende dich bei "
        "Fragen an den angegebenen Kontakt."
    ),
    "Version {version} of {date}": "Version {version} vom {date}",
    "The privacy notice is unavailable at the moment.": (
        "Der Datenschutzhinweis ist derzeit nicht verfügbar."
    ),
    "Claim submitted": "Antrag eingereicht",
    "Progress": "Fortschritt",
    "Details & receipts": "Angaben & Belege",
    "Review & sign": "Prüfen & unterschreiben",
    "Submitted": "Eingereicht",
    "Thank you. Your claim has been submitted.": "Danke. Dein Antrag wurde eingereicht.",
    "We have received your details and receipts. This confirmation of receipt is not yet "
    "an approval of the reimbursement.": (
        "Deine Angaben und Belege sind eingegangen. Die Eingangsbestätigung ist noch keine "
        "Zusage zur Erstattung."
    ),
    "Your reference": "Deine Referenz",
    "Please note the reference for any questions.": "Bitte notiere die Referenz für Rückfragen.",
    "Your claim is being processed.": "Dein Antrag wird verarbeitet.",
    # The form page (portal/templates/portal/form.html)
    "Test environment · Please use sample data only. No real emails are sent.": (
        "Testumgebung · Bitte nur Beispieldaten verwenden. Es werden keine echten E-Mails "
        "versendet."
    ),
    "Preview · This form is not open. Uploading and submitting are not possible.": (
        "Vorschau · Dieses Formular ist nicht geöffnet. Hochladen und Einreichen sind nicht "
        "möglich."
    ),
    "Submit by {date} {zone}": "Einreichen bis {date} {zone}",
    "For private individuals only.": "Nur für Privatpersonen.",
    "This form is for expenses you paid yourself. Organisations and companies, please send "
    "us an invoice.": (
        "Dieses Formular ist für Auslagen, die du selbst bezahlt hast. Organisationen und "
        "Unternehmen stellen uns bitte eine Rechnung."
    ),
    "Please enable JavaScript to upload receipts and submit the form.": (
        "Bitte aktiviere JavaScript, um Belege hochzuladen und das Formular einzureichen."
    ),
    "Your details": "Deine Angaben",
    "For assigning and transferring your reimbursement.": (
        "Für die Zuordnung und Überweisung deiner Erstattung."
    ),
    "For the confirmation of receipt and questions about your claim.": (
        "Für die Eingangsbestätigung und Rückfragen zu deinem Antrag."
    ),
    "The name the account is held in.": "Name, auf den das Konto läuft.",
    "IBANs from other countries are possible too.": "Auch ausländische IBANs sind möglich.",
    "Only needed for accounts outside the SEPA area.": (
        "Nur nötig für Konten außerhalb des SEPA-Raums."
    ),
    "Reason for the reimbursement": "Anlass der Erstattung",
    "What were the expenses for?": "Wofür sind die Auslagen entstanden?",
    "Optional: describe the connection in more detail if needed.": (
        "Optional: Beschreibe, falls nötig, den Zusammenhang genauer."
    ),
    "Expenses & receipts": "Auslagen & Belege",
    "Add one or more items. All amounts in euros.": (
        "Lege eine oder mehrere Positionen an. Alle Beträge in Euro."
    ),
    "Expense with receipt": "Auslage mit Beleg",
    "Mileage claim": "Kilometererstattung",
    "Add travel details for expenses with receipts (optional)": (
        "Reiseangaben für Auslagen mit Beleg ergänzen (optional)"
    ),
    "Travel details for expenses with receipts": "Reiseangaben für Auslagen mit Beleg",
    '<span aria-hidden="true">*</span> Required fields<br>Until you submit, your details '
    "stay only in this open form.": (
        '<span aria-hidden="true">*</span> Pflichtfelder<br>Deine Angaben bleiben bis zum '
        "Absenden nur in diesem geöffneten Formular."
    ),
    'Review details <span aria-hidden="true">→</span>': (
        'Angaben prüfen <span aria-hidden="true">→</span>'
    ),
    "Check your details": "Prüfe deine Angaben",
    "Once submitted, you can no longer change the claim.": (
        "Nach dem Einreichen kannst du den Antrag nicht mehr bearbeiten."
    ),
    "Edit details": "Angaben bearbeiten",
    "Declaration & signature": "Erklärung & Unterschrift",
    "I confirm the declaration. *": "Ich bestätige die Erklärung. *",
    "Sign here": "Hier unterschreiben",
    "Drawing area for your signature": "Zeichenfläche für deine Unterschrift",
    "Clear signature": "Unterschrift löschen",
    "Or upload it as an image": "Oder als Bild hochladen",
    "We process your details, receipts and signature to reimburse your expenses. We delete "
    "the PDF 7 days after it reaches accounting, and all other data in the portal 90 days "
    "after submission.": (
        "Wir verarbeiten deine Angaben, Belege und deine Unterschrift, um deine Auslagen zu "
        "erstatten. Die PDF löschen wir 7 Tage nach der Zustellung an die Buchhaltung, alle "
        "übrigen Daten im Portal 90 Tage nach dem Einreichen."
    ),
    "Read the full privacy notice": "Vollständigen Datenschutzhinweis lesen",
    'I have read the <a class="ui-link" href="{url}" target="_blank" rel="noopener">privacy '
    "notice</a>. *": (
        'Ich habe den <a class="ui-link" href="{url}" target="_blank" rel="noopener">'
        "Datenschutzhinweis</a> gelesen. *"
    ),
    "Submitting makes your claim binding. Accounting reviews it and makes the payment.": (
        "Mit dem Absenden wird dein Antrag verbindlich eingereicht. Die Prüfung und "
        "Auszahlung übernimmt die Buchhaltung."
    ),
    'Submit claim <span aria-hidden="true">→</span>': (
        'Antrag einreichen <span aria-hidden="true">→</span>'
    ),
    "Move item up": "Position nach oben verschieben",
    "Move item down": "Position nach unten verschieben",
    "Business partner *": "Name Geschäftspartner *",
    "e.g. ticket office": "z. B. Fahrkartenverkauf",
    "Reference/invoice no.": "Referenz/Rechnungsnr.",
    "if available": "falls vorhanden",
    "Amount in EUR *": "Betrag in EUR *",
    "0.00": "0,00",
    "Add receipt": "Beleg hinzufügen",
    "Date of the outward journey *": "Datum der Hinfahrt *",
    "Registration *": "Kennzeichen *",
    "e.g. B-AB 123": "z. B. B-AB 123",
    "From *": "Start *",
    "Place": "Ort",
    "To *": "Ziel *",
    "Distance (one way, km) *": "Entfernung (einfache Strecke, km) *",
    "Return journey": "Hin- und Rückfahrt",
    "Date of the return journey *": "Rückfahrtdatum *",
    "Add supporting file (optional)": "Nachweis hinzufügen (optional)",
    "For example, a screenshot of the route.": "Zum Beispiel ein Screenshot der Route.",
    # The claim PDF (portal/templates/portal/summary.html, portal.services.documents)
    "Item {number}": "Position {number}",
    "Reimbursement {reference}": "Erstattung {reference}",
    "Reimbursement of privately paid costs": "Erstattung privat verauslagter Kosten",
    "Reimbursement form": "Erstattungsformular",
    "Submitted on {date} {zone} · Form version {version}": (
        "Eingereicht am {date} {zone} · Formularversion {version}"
    ),
    "Personal details": "Angaben zur Person",
    "Address": "Anschrift",
    "Assignment": "Zuordnung",
    "Form": "Formular",
    "Template": "Vorlage",
    "Travel period": "Reisezeitraum",
    "{start} to {end}": "{start} bis {end}",
    "Expense items": "Auslagenpositionen",
    "No.": "Nr.",
    "Business partner / journey": "Geschäftspartner / Fahrt",
    "Occasion/purpose": "Anlass/Zweck",
    "Reference": "Referenz",
    "Amount": "Betrag",
    "Mileage allowance": "Kilometerpauschale",
    "Return on {date}": "Rückfahrt am {date}",
    "Return": "Rückfahrt",
    "The receipts follow in item order and, within each item, in the chosen file order. "
    "PDF bookmarks assign the pages to the items.": (
        "Die Belege folgen in Positionsreihenfolge und innerhalb jeder Position in der "
        "gewählten Dateireihenfolge. PDF-Lesezeichen ordnen die Seiten den Positionen zu."
    ),
    "Declaration and signature": "Erklärung und Unterschrift",
    "Signature": "Unterschrift",
    "Declaration {version} confirmed. Privacy notice version {privacy} acknowledged.": (
        "Erklärung {version} bestätigt. Datenschutzhinweis Version {privacy} zur Kenntnis genommen."
    ),
}
