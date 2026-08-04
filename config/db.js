import mongoose from 'mongoose';

// A serverless runtime has no "startup": the module is imported fresh on every
// cold start, and a burst of requests can hit one instance before any connection
// exists. So connecting has to be idempotent and cached rather than done once.
// The cached promise (not just the connection) is what stops concurrent requests
// on a cold start from each opening their own pool.
let connectionPromise = null;

// The URI is read at call time (not import time) so scripts/tests can point at a
// different database before connecting.
export const connectMongo = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('Missing MONGODB_URI.');
  }

  // 1 === connected. Reuse the pool this warm instance already has.
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      // Fail in seconds rather than hanging until the platform's request timeout,
      // so an unreachable database surfaces as an error instead of a dead request.
      .connect(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 })
      .then(() => {
        console.log('Connected to MongoDB');
        return mongoose.connection;
      })
      .catch((err) => {
        connectionPromise = null; // let the next request retry
        throw err;
      });
  }

  return connectionPromise;
};
