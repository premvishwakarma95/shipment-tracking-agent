import "dotenv/config";
import mongoose from "mongoose";

let connected = false;

export async function connectDB(): Promise<void> {
  if (connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Missing required environment variable: MONGODB_URI");
  }
  await mongoose.connect(uri);
  connected = true;
  console.log("[db] connected");
}

export async function disconnectDB(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
