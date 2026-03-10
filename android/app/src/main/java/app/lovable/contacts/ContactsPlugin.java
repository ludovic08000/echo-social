package app.lovable.contacts;

import android.Manifest;
import android.database.Cursor;
import android.provider.ContactsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(
    name = "ContactsPlugin",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = "contacts")
    }
)
public class ContactsPlugin extends Plugin {

    @PluginMethod
    public void requestPermission(PluginCall call) {
        PermissionState permissionState = getPermissionState("contacts");

        if (permissionState == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        requestPermissionForAlias("contacts", call, "contactsPermissionCallback");
    }

    @PluginMethod
    public void getContacts(PluginCall call) {
        PermissionState permissionState = getPermissionState("contacts");

        if (permissionState != PermissionState.GRANTED) {
            call.reject("Permission READ_CONTACTS refusée");
            return;
        }

        try {
            JSArray contacts = fetchContacts();
            JSObject ret = new JSObject();
            ret.put("contacts", contacts);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Impossible de lire les contacts", e);
        }
    }

    @SuppressWarnings("unused")
    private void contactsPermissionCallback(PluginCall call) {
        if (call == null) return;

        PermissionState permissionState = getPermissionState("contacts");
        JSObject ret = new JSObject();
        ret.put("granted", permissionState == PermissionState.GRANTED);
        call.resolve(ret);
    }

    private JSArray fetchContacts() {
        Map<String, ContactAccumulator> grouped = new HashMap<>();

        String[] projection = new String[] {
            ContactsContract.Data.CONTACT_ID,
            ContactsContract.Data.MIMETYPE,
            ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME,
            ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Email.ADDRESS
        };

        Cursor cursor = getContext().getContentResolver().query(
            ContactsContract.Data.CONTENT_URI,
            projection,
            ContactsContract.Data.MIMETYPE + " IN (?, ?, ?)",
            new String[] {
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE
            },
            ContactsContract.Data.CONTACT_ID + " ASC"
        );

        if (cursor == null) {
            return new JSArray();
        }

        try {
            int contactIdIndex = cursor.getColumnIndex(ContactsContract.Data.CONTACT_ID);
            int mimeTypeIndex = cursor.getColumnIndex(ContactsContract.Data.MIMETYPE);
            int givenNameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME);
            int familyNameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME);
            int phoneIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
            int emailIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Email.ADDRESS);

            while (cursor.moveToNext()) {
                String contactId = safeGetString(cursor, contactIdIndex);
                if (contactId == null || contactId.isEmpty()) continue;

                ContactAccumulator acc = grouped.get(contactId);
                if (acc == null) {
                    acc = new ContactAccumulator();
                    grouped.put(contactId, acc);
                }

                String mimeType = safeGetString(cursor, mimeTypeIndex);

                if (ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE.equals(mimeType)) {
                    String givenName = safeGetString(cursor, givenNameIndex);
                    String familyName = safeGetString(cursor, familyNameIndex);
                    if (givenName != null) acc.givenName = givenName.trim();
                    if (familyName != null) acc.familyName = familyName.trim();
                } else if (ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE.equals(mimeType)) {
                    String phone = safeGetString(cursor, phoneIndex);
                    phone = normalizePhone(phone);
                    if (phone != null && !phone.isEmpty()) {
                        acc.phoneNumbers.add(phone);
                    }
                } else if (ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE.equals(mimeType)) {
                    String email = safeGetString(cursor, emailIndex);
                    if (email != null) {
                        email = email.trim().toLowerCase();
                        if (!email.isEmpty()) {
                            acc.emails.add(email);
                        }
                    }
                }
            }
        } finally {
            cursor.close();
        }

        JSArray result = new JSArray();

        for (Map.Entry<String, ContactAccumulator> entry : grouped.entrySet()) {
            ContactAccumulator acc = entry.getValue();

            if (acc.phoneNumbers.isEmpty() && acc.emails.isEmpty()) {
                continue;
            }

            String fullName = ((acc.givenName == null ? "" : acc.givenName) + " " +
                               (acc.familyName == null ? "" : acc.familyName)).trim();

            JSObject obj = new JSObject();
            obj.put("givenName", acc.givenName == null ? "" : acc.givenName);
            obj.put("familyName", acc.familyName == null ? "" : acc.familyName);
            obj.put("fullName", fullName);

            JSArray phones = new JSArray();
            for (String phone : acc.phoneNumbers) {
                phones.put(phone);
            }

            JSArray emails = new JSArray();
            for (String email : acc.emails) {
                emails.put(email);
            }

            obj.put("phoneNumbers", phones);
            obj.put("emails", emails);

            result.put(obj);
        }

        return result;
    }

    private static String safeGetString(Cursor cursor, int index) {
        if (index < 0 || cursor.isNull(index)) return null;
        return cursor.getString(index);
    }

    private static String normalizePhone(String raw) {
        if (raw == null) return null;
        return raw.replaceAll("[^+0-9]", "");
    }

    private static class ContactAccumulator {
        String givenName = "";
        String familyName = "";
        Set<String> phoneNumbers = new HashSet<>();
        Set<String> emails = new HashSet<>();
    }
}
