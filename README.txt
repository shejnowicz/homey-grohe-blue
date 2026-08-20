GROHE Blue Home for Homey

Monitor and control GROHE Blue Home from Homey Pro. View online state, filter and CO₂ percentages, remaining liters, localized measurement time, idle time, and still/carbonated cycle counters. Receive low-level alarms and use Flow cards for state changes and low filter or CO₂ levels.

Automatic flushing can be enabled or disabled from Homey and is reported as successful only after the GROHE API confirms the effective state. Ambiguous writes are not retried. The GROHE Watersystems UI may cache this setting until logout/login, so Homey relies on backend confirmation reads.

The developer build has been installed on Homey Pro, paired with a real account, discovered a Blue Home appliance, displayed live monitoring values, and exercised backend-confirmed enable and disable. Real low-threshold crossings, controlled outage behavior, and expired-session re-login remain pending and are currently mock-tested.

A GROHE Watersystems account, GROHE Blue Home appliance, internet connection, and compatible Homey Pro are required.
