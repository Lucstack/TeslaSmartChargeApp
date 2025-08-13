// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

// Import the necessary Firebase modules using the latest syntax.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Import modules for making API requests and parsing XML.
const axios = require('axios');
const xml2js = require('xml2js');

// Initialize the Firebase Admin SDK.
admin.initializeApp();
const db = admin.firestore();

// Define secrets for our API keys.
const entsoeApiKey = defineSecret('ENTSOE_API_KEY');
const teslaClientId = defineSecret('TESLA_CLIENT_ID');
const teslaClientSecret = defineSecret('TESLA_CLIENT_SECRET');

/**
 * [Function A] Fetches day-ahead electricity prices from the ENTSO-E API.
 * Trigger: Runs on a schedule every day at 1:10 AM.
 */
exports.fetchEnergyPrices = onSchedule(
  {
    schedule: '10 1 * * *',
    timeZone: 'Europe/Amsterdam',
    region: 'europe-west1',
    secrets: [entsoeApiKey],
  },
  async event => {
    logger.info('Running fetchEnergyPrices function...');
    const REGION_CODE = '10YNL----------L';
    const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;

    try {
      const periodStart = new Date();
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 1);

      const formatDate = date => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}0000`;
      };

      const apiUrl = `https://web-api.tp.entsoe.eu/api?securityToken=${ENTSOE_API_KEY}&documentType=A44&in_Domain=${REGION_CODE}&out_Domain=${REGION_CODE}&periodStart=${formatDate(
        periodStart
      )}&periodEnd=${formatDate(periodEnd)}`;

      logger.info(`Fetching data from ENTSO-E API...`);
      const response = await axios.get(apiUrl);
      const xmlResponse = response.data;

      const parser = new xml2js.Parser({ explicitArray: true });
      const parsedData = await parser.parseStringPromise(xmlResponse);

      const timeSeries = parsedData.Publication_MarketDocument.TimeSeries;
      if (!timeSeries || timeSeries.length === 0) {
        throw new Error('No TimeSeries data found in the API response.');
      }

      const relevantTimeSeries = timeSeries[timeSeries.length - 1];
      const period = relevantTimeSeries.Period[0];
      const points = period.Point;

      if (!points || points.length === 0) {
        throw new Error('No price points found in the relevant TimeSeries.');
      }

      const periodStartTime = new Date(period.timeInterval[0].start[0]);
      const hourlyRates = {};
      points.forEach(point => {
        const hour = parseInt(point.position[0], 10) - 1;
        const price = parseFloat(point['price.amount'][0]) / 1000;

        const pointTime = new Date(periodStartTime.getTime());
        pointTime.setHours(pointTime.getHours() + hour);

        hourlyRates[hour] = {
          price: price,
          time: pointTime.toISOString(),
        };
      });

      const priceData = {
        lastUpdated: new Date(),
        hourlyRates: hourlyRates,
      };

      await db.collection('energy_prices').doc('NL').set(priceData);
      logger.info('Successfully fetched and saved energy prices for NL.', {
        numberOfRates: Object.keys(hourlyRates).length,
      });
    } catch (error) {
      logger.error('Error in fetchEnergyPrices:', error.message);
    }
  }
);

/**
 * [Function B] Calculates the optimal charging window for all users.
 * Trigger: Runs automatically whenever the energy price data is updated.
 */
exports.calculateOptimalWindow = onDocumentUpdated(
  {
    document: 'energy_prices/NL',
    region: 'europe-west1', // CORRECTED: Added region to match the trigger.
  },
  async event => {
    logger.info(
      'Running calculateOptimalWindow function because prices were updated.'
    );

    const priceData = event.data.after.data();
    const hourlyRates = priceData.hourlyRates;

    if (!hourlyRates) {
      logger.error('No hourlyRates found in the price data.');
      return;
    }

    const prices = Object.values(hourlyRates).map(rate => rate.price);

    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      logger.info('No users found in the database. Exiting function.');
      return;
    }

    const batch = db.batch();

    usersSnapshot.forEach(userDoc => {
      const userData = userDoc.data();
      const userSettings = userData.settings;

      if (!userSettings || !userSettings.chargingDuration) {
        logger.warn(`User ${userDoc.id} has no settings. Skipping.`);
        return;
      }

      const hoursNeeded = userSettings.chargingDuration;
      let bestStartHour = -1;
      let lowestAveragePrice = Infinity;

      for (
        let startHour = 0;
        startHour <= prices.length - hoursNeeded;
        startHour++
      ) {
        const windowPrices = prices.slice(startHour, startHour + hoursNeeded);
        const averagePrice =
          windowPrices.reduce((a, b) => a + b, 0) / hoursNeeded;

        if (averagePrice < lowestAveragePrice) {
          lowestAveragePrice = averagePrice;
          bestStartHour = startHour;
        }
      }

      if (bestStartHour !== -1) {
        logger.info(
          `Optimal window for user ${userDoc.id} is ${hoursNeeded} hours starting at ${bestStartHour}:00.`
        );

        const userRef = db.collection('users').doc(userDoc.id);
        batch.update(userRef, {
          'settings.optimalStartHour': bestStartHour,
        });
      }
    });

    await batch.commit();
    logger.info(
      'Finished calculating and saving optimal windows for all users.'
    );
  }
);

/**
 * [Function C] Receives real-time data from Tesla's Fleet Telemetry.
 * Trigger: HTTP POST request from Tesla's servers.
 */
exports.telemetryWebhook = onRequest(
  { region: 'europe-west1' },
  async (req, res) => {
    logger.info('Received data from Tesla Telemetry:', req.body);

    const { vin, data } = req.body;

    if (!vin || !data) {
      logger.warn('Received invalid telemetry data.');
      res.status(400).send('Bad Request');
      return;
    }

    try {
      const usersRef = db.collection('users');
      const snapshot = await usersRef
        .where('vehicle.vin', '==', vin)
        .limit(1)
        .get();

      if (snapshot.empty) {
        logger.warn(`Received telemetry for unknown VIN: ${vin}`);
        res.status(200).send('OK');
        return;
      }

      const userDoc = snapshot.docs[0];
      const userId = userDoc.id;

      const vehicleUpdate = {};
      if (data.charging_state) {
        vehicleUpdate['vehicle.isCharging'] =
          data.charging_state === 'Charging';
      }
      if (data.charge_port_latch) {
        vehicleUpdate['vehicle.isPluggedIn'] =
          data.charge_port_latch === 'Engaged';
      }
      if (data.battery_level) {
        vehicleUpdate['vehicle.batteryLevel'] = data.battery_level;
      }

      if (Object.keys(vehicleUpdate).length > 0) {
        await db.collection('users').doc(userId).update(vehicleUpdate);
        logger.info(`Updated vehicle status for user ${userId}`);
      }

      res.status(200).send('OK');
    } catch (error) {
      logger.error(`Error processing telemetry for VIN ${vin}:`, error);
      res.status(500).send('Internal Server Error');
    }
  }
);

/**
 * [Function D] Makes the charging decision for a user.
 * Trigger: Runs whenever a user's vehicle status is updated in Firestore.
 */
exports.manageChargingLogic = onDocumentUpdated(
  {
    document: 'users/{userId}',
    region: 'europe-west1',
    secrets: [teslaClientId, teslaClientSecret],
  },
  async event => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    const userId = event.params.userId;

    // --- NEW: Manual Override Logic ---
    // Check if the chargeOverride flag was just set to true.
    if (
      afterData.chargeOverride === true &&
      beforeData.chargeOverride !== true
    ) {
      logger.info(
        `Manual override detected for user ${userId}. Starting charge.`
      );
      try {
        await sendTeslaChargeCommand(
          afterData.teslaRefreshToken,
          afterData.vehicle.vin,
          'START'
        );
        // Reset the override flag so this doesn't run again.
        await event.data.after.ref.update({ chargeOverride: false });
        logger.info(`Charge override successful, flag reset for ${userId}.`);
        return; // Exit the function since we've taken action.
      } catch (error) {
        logger.error(`Error during manual override for user ${userId}:`, error);
        // Still try to reset the flag even if the command fails.
        await event.data.after.ref.update({ chargeOverride: false });
        return;
      }
    }
    // --- End of New Logic ---

    // Check if the car was just plugged in for normal smart charging.
    if (
      beforeData.vehicle.isPluggedIn === false &&
      afterData.vehicle.isPluggedIn === true
    ) {
      logger.info(`Car plugged in for user ${userId}. Running charging logic.`);

      const { settings, vehicle, teslaRefreshToken } = afterData;
      const { optimalStartHour, emergencyThreshold, targetBattery } = settings;
      const { batteryLevel } = vehicle;

      try {
        const priceDoc = await db.collection('energy_prices').doc('NL').get();
        if (!priceDoc.exists) {
          throw new Error('Energy prices not found.');
        }
        const prices = priceDoc.data().hourlyRates;
        const currentHour = new Date().getHours();
        const currentPrice = prices[currentHour].price;

        // --- Decision Logic ---
        let decision = 'STOP';

        // 1. Emergency Charging
        if (batteryLevel < emergencyThreshold) {
          decision = 'START';
          logger.info(`Decision for ${userId}: START (Emergency Charging)`);
        }
        // 2. Bonus Charging
        else if (currentPrice < 0) {
          decision = 'START';
          logger.info(`Decision for ${userId}: START (Bonus Charging)`);
        }
        // 3. Optimal Charging
        else if (
          currentHour >= optimalStartHour &&
          currentHour < optimalStartHour + settings.chargingDuration &&
          batteryLevel < targetBattery
        ) {
          decision = 'START';
          logger.info(`Decision for ${userId}: START (Optimal Window)`);
        } else {
          logger.info(`Decision for ${userId}: STOP (Outside optimal window)`);
        }

        await sendTeslaChargeCommand(teslaRefreshToken, vehicle.vin, decision);
      } catch (error) {
        logger.error(`Error in manageChargingLogic for user ${userId}:`, error);
      }
    }
  }
);
/**
 * [Function E] Exchanges a Tesla auth code for a refresh token.
 * Trigger: Called directly from the Flutter app.
 */
exports.exchangeAuthCodeForToken = onCall(
  { region: 'europe-west1', secrets: [teslaClientId, teslaClientSecret] },
  async request => {
    // The user must be authenticated with Firebase to call this function.
    if (!request.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'The function must be called while authenticated.'
      );
    }

    const authCode = request.data.code;
    if (!authCode) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The function must be called with an "code" argument.'
      );
    }

    const userId = request.auth.uid;
    logger.info(`Exchanging auth code for user ${userId}`);

    try {
      // Make the secure, server-to-server request to Tesla
      const response = await axios.post(
        'https://auth.tesla.com/oauth2/v3/token',
        {
          grant_type: 'authorization_code',
          client_id: teslaClientId.value(),
          client_secret: teslaClientSecret.value(),
          code: authCode,
          audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
          redirect_uri: 'https://teslasmartchargeapp/auth/callback', // Must match your callback
        }
      );

      const refreshToken = response.data.refresh_token;

      if (!refreshToken) {
        throw new Error('Refresh token not found in Tesla response.');
      }

      // Securely save the new token to the user's document
      await db.collection('users').doc(userId).update({
        teslaRefreshToken: refreshToken,
      });

      logger.info(`Successfully stored refresh token for user ${userId}`);
      return { success: true, message: 'Tesla account connected!' };
    } catch (error) {
      logger.error(
        `Error exchanging auth code for user ${userId}:`,
        error.response ? error.response.data : error.message
      );
      throw new functions.https.HttpsError(
        'internal',
        'Failed to connect to Tesla.'
      );
    }
  }
);
/**
 * Helper function to get a new Tesla access token using the refresh token.
 */
async function getTeslaAccessToken(refreshToken) {
  const response = await axios.post('https://auth.tesla.com/oauth2/v3/token', {
    grant_type: 'refresh_token',
    client_id: teslaClientId.value(),
    client_secret: teslaClientSecret.value(),
    refresh_token: refreshToken,
  });
  return response.data.access_token;
}

/**
 * Helper function to send a start or stop charging command to a Tesla vehicle.
 */
async function sendTeslaChargeCommand(refreshToken, vin, command) {
  try {
    const accessToken = await getTeslaAccessToken(refreshToken);
    const action = command === 'START' ? 'charge_start' : 'charge_stop';

    logger.info(`Sending command '${action}' to VIN ${vin}`);

    // This is a placeholder for the actual command.
    // const response = await axios.post(`https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vin}/command/${action}`, {}, {
    //     headers: { 'Authorization': `Bearer ${accessToken}` }
    // });
    // logger.info(`Successfully sent command to VIN ${vin}`, response.data);
  } catch (error) {
    logger.error(
      `Failed to send command to VIN ${vin}:`,
      error.response ? error.response.data : error.message
    );
  }
}
