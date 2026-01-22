/**
 * Cancel Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Cancels customer appointments by phone lookup
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 *
 * UPDATED: Now includes linked profile appointments (minors/guests)
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// PRODUCTION Meevo API Configuration
const CONFIG = {
  AUTH_URL: 'https://marketplace.meevo.com/oauth2/token',
  API_URL: 'https://na1pub.meevo.com/publicapi/v1',
  CLIENT_ID: 'f6a5046d-208e-4829-9941-034ebdd2aa65',
  CLIENT_SECRET: '2f8feb2e-51f5-40a3-83af-3d4a6a454abe',
  TENANT_ID: '200507',
  LOCATION_ID: '201664'  // Phoenix Encanto
};

let token = null;
let tokenExpiry = null;

// Normalize phone to 10-digit format
function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

async function getToken() {
  if (token && tokenExpiry && Date.now() < tokenExpiry - 300000) return token;

  console.log('Getting fresh PRODUCTION token...');
  const res = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return token;
}

/**
 * Find linked profiles (minors/guests) for a guardian
 */
async function findLinkedProfiles(authToken, guardianId, locationId) {
  const linkedProfiles = [];
  const seenIds = new Set();

  console.log(`PRODUCTION: Finding linked profiles for guardian: ${guardianId}`);

  const PAGE_RANGES = [
    { start: 150, end: 200 },
    { start: 100, end: 150 },
    { start: 50, end: 100 },
    { start: 1, end: 50 }
  ];

  for (const range of PAGE_RANGES) {
    for (let batchStart = range.start; batchStart < range.end; batchStart += 10) {
      const pagePromises = [];

      for (let page = batchStart; page < batchStart + 10 && page <= range.end; page++) {
        pagePromises.push(
          axios.get(
            `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=100`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
          ).catch(() => ({ data: { data: [] } }))
        );
      }

      const results = await Promise.all(pagePromises);
      let emptyPages = 0;
      const candidateClients = [];

      for (const result of results) {
        const clients = result.data?.data || [];
        if (clients.length === 0) {
          emptyPages++;
          continue;
        }

        for (const c of clients) {
          if (seenIds.has(c.clientId)) continue;
          if (!c.primaryPhoneNumber) {
            candidateClients.push(c);
          }
        }
      }

      for (let i = 0; i < candidateClients.length; i += 50) {
        const batch = candidateClients.slice(i, i + 50);
        const detailPromises = batch.map(c =>
          axios.get(
            `${CONFIG.API_URL}/client/${c.clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 2000 }
          ).catch(() => null)
        );

        const detailResults = await Promise.all(detailPromises);

        for (const detailRes of detailResults) {
          if (!detailRes) continue;
          const client = detailRes.data?.data || detailRes.data;
          if (!client || seenIds.has(client.clientId)) continue;

          seenIds.add(client.clientId);

          if (client.guardianId === guardianId) {
            linkedProfiles.push({
              client_id: client.clientId,
              first_name: client.firstName,
              last_name: client.lastName,
              name: `${client.firstName} ${client.lastName}`
            });
            console.log(`PRODUCTION: Found linked profile: ${client.firstName} ${client.lastName}`);
          }
        }
      }

      if (emptyPages >= 10) break;
    }

    if (linkedProfiles.length > 0) break;
  }

  return linkedProfiles;
}

/**
 * Get appointments for a specific client
 */
async function getClientAppointments(authToken, clientId, clientName, locationId) {
  try {
    const appointmentsRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );

    const allAppointments = appointmentsRes.data?.data || appointmentsRes.data || [];
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    return allAppointments
      .filter(apt => {
        const aptTime = new Date(apt.startTime);
        return (aptTime > now || aptTime >= startOfToday) && !apt.isCancelled;
      })
      .map(apt => ({
        appointment_id: apt.appointmentId,
        appointment_service_id: apt.appointmentServiceId,
        datetime: apt.startTime,
        service_id: apt.serviceId,
        stylist_id: apt.employeeId,
        concurrency_check: apt.concurrencyCheckDigits,
        client_id: clientId,
        client_name: clientName
      }));
  } catch (error) {
    console.log(`Error getting appointments for ${clientName}:`, error.message);
    return [];
  }
}

app.post('/cancel', async (req, res) => {
  try {
    const { phone, email, appointment_service_id, concurrency_check } = req.body;

    console.log('PRODUCTION Cancel request:', JSON.stringify(req.body));

    if (!appointment_service_id && !phone && !email) {
      return res.json({
        success: false,
        error: 'Please provide appointment_service_id or phone/email to lookup'
      });
    }

    const authToken = await getToken();

    let serviceId = appointment_service_id;
    let concurrencyDigits = concurrency_check;

    // FAST PATH: If appointment_service_id is provided WITH phone, find client first then match appointment
    if (serviceId && phone && !concurrencyDigits) {
      console.log('PRODUCTION: Using provided appointment_service_id:', serviceId);
      console.log('PRODUCTION: Finding client by phone first (fast path)...');

      const cleanPhone = normalizePhone(phone);
      let foundClient = null;

      // Find client by phone (fast - parallel pagination)
      const PAGES_PER_BATCH = 10;
      const MAX_BATCHES = 20;

      for (let batch = 0; batch < MAX_BATCHES && !foundClient; batch++) {
        const startPage = batch * PAGES_PER_BATCH + 1;
        const pagePromises = [];

        for (let i = 0; i < PAGES_PER_BATCH; i++) {
          const page = startPage + i;
          pagePromises.push(
            axios.get(
              `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&PageNumber=${page}&ItemsPerPage=100`,
              { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
            ).catch(() => ({ data: { data: [] } }))
          );
        }

        const results = await Promise.all(pagePromises);
        let emptyPages = 0;

        for (const result of results) {
          const clients = result.data?.data || [];
          if (clients.length === 0) emptyPages++;

          for (const c of clients) {
            const clientPhone = normalizePhone(c.primaryPhoneNumber);
            if (clientPhone === cleanPhone) {
              foundClient = c;
              break;
            }
          }
          if (foundClient) break;
        }

        if (emptyPages === PAGES_PER_BATCH) break;
      }

      if (!foundClient) {
        return res.json({
          success: false,
          error: 'No client found with that phone number'
        });
      }

      // First check main client's appointments (fast)
      let found = false;
      console.log('PRODUCTION: Checking main client appointments first');

      try {
        const apptRes = await axios.get(
          `${CONFIG.API_URL}/book/client/${foundClient.clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
          { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
        );
        const appointments = apptRes.data?.data || apptRes.data || [];
        const match = appointments.find(a => a.appointmentServiceId === serviceId);
        if (match) {
          concurrencyDigits = match.concurrencyCheckDigits;
          console.log('PRODUCTION: Found concurrency_check:', concurrencyDigits, 'for main client', foundClient.firstName, foundClient.lastName);
          found = true;
        }
      } catch (e) {
        console.log('Error checking main client appointments:', e.message);
      }

      // Only search linked profiles if not found for main client
      if (!found) {
        console.log('PRODUCTION: Not found for main client, checking linked profiles...');
        const linkedProfiles = await findLinkedProfiles(authToken, foundClient.clientId, CONFIG.LOCATION_ID);

        for (const profile of linkedProfiles) {
          try {
            const apptRes = await axios.get(
              `${CONFIG.API_URL}/book/client/${profile.client_id}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
              { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
            );
            const appointments = apptRes.data?.data || apptRes.data || [];
            const match = appointments.find(a => a.appointmentServiceId === serviceId);
            if (match) {
              concurrencyDigits = match.concurrencyCheckDigits;
              console.log('PRODUCTION: Found concurrency_check:', concurrencyDigits, 'for linked profile', profile.first_name, profile.last_name);
              found = true;
              break;
            }
          } catch (e) {
            console.log('Error checking appointments for', profile.first_name, ':', e.message);
          }
        }
      }

      if (!found) {
        return res.json({
          success: false,
          error: 'Could not find appointment with that ID for this caller'
        });
      }
    } else if (serviceId && concurrencyDigits) {
      // Already have everything we need - skip lookup
      console.log('PRODUCTION: Using provided appointment_service_id and concurrency_check');
    } else if (!serviceId) {
      // Step 1: Find client with parallel pagination
      const cleanPhone = phone ? normalizePhone(phone) : null;
      const cleanEmail = email?.toLowerCase();
      let foundClient = null;

      const PAGES_PER_BATCH = 10;
      const ITEMS_PER_PAGE = 100;
      const MAX_BATCHES = 20;

      for (let batch = 0; batch < MAX_BATCHES && !foundClient; batch++) {
        const startPage = batch * PAGES_PER_BATCH + 1;
        const pagePromises = [];

        for (let i = 0; i < PAGES_PER_BATCH; i++) {
          const page = startPage + i;
          pagePromises.push(
            axios.get(
              `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`,
              { headers: { Authorization: `Bearer ${authToken}` } }
            ).catch(() => ({ data: { data: [] } }))
          );
        }

        const results = await Promise.all(pagePromises);
        let emptyPages = 0;

        for (const result of results) {
          const clients = result.data?.data || [];
          if (clients.length === 0) emptyPages++;

          for (const c of clients) {
            if (cleanPhone) {
              const clientPhone = normalizePhone(c.primaryPhoneNumber);
              if (clientPhone === cleanPhone) {
                foundClient = c;
                console.log('PRODUCTION: Found client by phone:', c.firstName, c.lastName);
                break;
              }
            }
            if (cleanEmail && c.emailAddress?.toLowerCase() === cleanEmail) {
              foundClient = c;
              console.log('PRODUCTION: Found client by email:', c.firstName, c.lastName);
              break;
            }
          }
          if (foundClient) break;
        }

        if (emptyPages === PAGES_PER_BATCH) break;
      }

      if (!foundClient) {
        return res.json({
          success: false,
          error: 'No client found with that phone number or email'
        });
      }

      // Step 2: Get caller's appointments
      const callerName = `${foundClient.firstName} ${foundClient.lastName}`;
      const callerAppointments = await getClientAppointments(
        authToken,
        foundClient.clientId,
        callerName,
        CONFIG.LOCATION_ID
      );

      // Step 3: Find linked profiles and their appointments
      const linkedProfiles = await findLinkedProfiles(authToken, foundClient.clientId, CONFIG.LOCATION_ID);
      let linkedAppointments = [];
      for (const profile of linkedProfiles) {
        const profileAppointments = await getClientAppointments(
          authToken,
          profile.client_id,
          profile.name,
          CONFIG.LOCATION_ID
        );
        linkedAppointments = linkedAppointments.concat(profileAppointments);
      }

      // Step 4: Combine and sort all appointments
      const allAppointments = [...callerAppointments, ...linkedAppointments];
      allAppointments.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

      console.log('PRODUCTION: Total appointments:', callerAppointments.length, '(caller) +', linkedAppointments.length, '(linked) =', allAppointments.length);

      if (allAppointments.length === 0) {
        return res.json({
          success: false,
          error: 'No upcoming appointments found'
        });
      }

      const nextAppt = allAppointments[0];
      serviceId = nextAppt.appointment_service_id;
      concurrencyDigits = nextAppt.concurrency_check;

      console.log('PRODUCTION: Found appointment to cancel:', serviceId, 'for', nextAppt.client_name, 'at', nextAppt.datetime);
    } // End of phone/email lookup block

    // Cancel the appointment
    const cancelRes = await axios.delete(
      `${CONFIG.API_URL}/book/service/${serviceId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}&ConcurrencyCheckDigits=${concurrencyDigits}`,
      { headers: { Authorization: `Bearer ${authToken}` }}
    );

    console.log('PRODUCTION Cancel response:', cancelRes.data);

    res.json({
      success: true,
      cancelled: true,
      message: 'Your appointment has been cancelled',
      appointment_service_id: serviceId
    });

  } catch (error) {
    console.error('PRODUCTION Cancel error:', error.message);
    res.json({
      success: false,
      error: error.response?.data?.error?.message || error.message
    });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  environment: 'PRODUCTION',
  location: 'Phoenix Encanto',
  service: 'Cancel Appointment'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PRODUCTION Cancel server running on port ${PORT}`));
