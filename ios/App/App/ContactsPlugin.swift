import Foundation
import Capacitor
import Contacts

@objc(ContactsPlugin)
public class ContactsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ContactsPlugin"
    public let jsName = "ContactsPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getContacts", returnType: CAPPluginReturnPromise)
    ]

    private let store = CNContactStore()

    @objc func requestPermission(_ call: CAPPluginCall) {
        let status = CNContactStore.authorizationStatus(for: .contacts)

        switch status {
        case .authorized:
            call.resolve(["granted": true])

        // iOS 18+ returns .limited for partial access
        case .limited:
            call.resolve(["granted": true])

        case .notDetermined:
            store.requestAccess(for: .contacts) { granted, error in
                if let error = error {
                    call.reject("Permission error: \(error.localizedDescription)", nil, error)
                    return
                }
                call.resolve(["granted": granted])
            }

        case .denied, .restricted:
            call.resolve(["granted": false])

        @unknown default:
            call.resolve(["granted": false])
        }
    }

    @objc func getContacts(_ call: CAPPluginCall) {
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor
        ]

        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true

        var contactsArray: [[String: Any]] = []

        do {
            try store.enumerateContacts(with: request) { contact, _ in
                let phones = contact.phoneNumbers
                    .map { $0.value.stringValue }
                    .map { self.normalizePhone($0) }
                    .filter { !$0.isEmpty }

                let emails = contact.emailAddresses
                    .map { String($0.value).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                    .filter { !$0.isEmpty }

                if phones.isEmpty && emails.isEmpty {
                    return
                }

                let givenName = contact.givenName.trimmingCharacters(in: .whitespacesAndNewlines)
                let familyName = contact.familyName.trimmingCharacters(in: .whitespacesAndNewlines)
                let fullName = "\(givenName) \(familyName)".trimmingCharacters(in: .whitespacesAndNewlines)

                contactsArray.append([
                    "givenName": givenName,
                    "familyName": familyName,
                    "fullName": fullName,
                    "phoneNumbers": Array(Set(phones)),
                    "emails": Array(Set(emails))
                ])
            }

            call.resolve(["contacts": contactsArray])
        } catch {
            call.reject("Failed to fetch contacts: \(error.localizedDescription)", nil, error)
        }
    }

    private func normalizePhone(_ raw: String) -> String {
        let allowed = CharacterSet(charactersIn: "+0123456789")
        let cleaned = raw.unicodeScalars.filter { allowed.contains($0) }
        return String(String.UnicodeScalarView(cleaned))
    }
}
