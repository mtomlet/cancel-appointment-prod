/**
 * Cancel Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Cancels customer appointments by phone lookup
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
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

app.post('/cancel', async (req, res) => {
  try {
    const { phone, email, appointment_service_id, concurrency_check } = req.body;

    if (!appointment_service_id && !phone && !email) {
      return res.json({
        success: false,
        error: 'Please provide appointment_service_id or phone/email to lookup'
      });
    }

    const authToken = await getToken();

    let serviceId = appointment_service_id;
    let concurrencyDigits = concurrency_check;

    // If phone/email provided, lookup the appointment
    if (!serviceId) {
      // Step 1: Find client
      const clientsRes = await axios.get(
        `${CONFIG.API_URL}/clients?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
        { headers: { Authorization: `Bearer ${authToken}` }}
      );

      const clients = clientsRes.data.data || clientsRes.data;
      const client = clients.find(c => {
        if (phone) {
          const cleanPhone = normalizePhone(phone);
          const clientPhone = normalizePhone(c.primaryPhoneNumber);
          return clientPhone === cleanPhone;
        }
        if (email) {
          return c.emailAddress?.toLowerCase() === email.toLowerCase();
        }
        return false;
      });

      if (!client) {
        return res.json({
          success: false,
          error: 'No client found with that phone number or email'
        });
      }

      // Step 2: Get next upcoming appointment
      const appointmentsRes = await axios.get(
        `${CONFIG.API_URL}/book/client/${client.clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
        { headers: { Authorization: `Bearer ${authToken}` }}
      );

      const allAppointments = appointmentsRes.data.data || appointmentsRes.data;
      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);

      const upcomingAppointments = allAppointments
        .filter(apt => {
          const aptTime = new Date(apt.startTime);
          return (aptTime > now || aptTime >= startOfToday) && !apt.isCancelled;
        })
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      if (upcomingAppointments.length === 0) {
        return res.json({
          success: false,
          error: 'No upcoming appointments found'
        });
      }

      const nextAppt = upcomingAppointments[0];
      serviceId = nextAppt.appointmentServiceId;
      concurrencyDigits = nextAppt.concurrencyCheckDigits;

      console.log('PRODUCTION: Found appointment to cancel:', serviceId, 'at', nextAppt.startTime);
    }

    // Step 3: Cancel the appointment
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
