import React, { useEffect, useState } from 'react';
import axios from 'axios';
import Spinner from './Spinner';

const API = 'https://center-kitchen-backend.onrender.com';

function CenterKitchen() {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [groupBy, setGroupBy] = useState('sauce');
  const [showMaster, setShowMaster] = useState(false);

  // Master form states
  const [newOutlet, setNewOutlet] = useState('');
  const [newSauce, setNewSauce] = useState('');
  const [sauceOutlet, setSauceOutlet] = useState('');
  const [sauceWeight, setSauceWeight] = useState('');
  const [outletList, setOutletList] = useState([]);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API}/orders`);
      setOrders(res.data);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadOutlets = async () => {
    try {
      const res = await axios.get(`${API}/outlets`);
      setOutletList(res.data);
    } catch (error) {
      console.error('Error loading outlets:', error);
    }
  };

  useEffect(() => {
    loadOrders();
    loadOutlets();
  }, []);

  if (loading) return <Spinner />;

  const pendingOrders = orders.filter(o => o.status !== 'delivered');

  const groupedOrders = {};
  pendingOrders.forEach(order => {
    let key = groupBy === 'sauce'
      ? order.sauce
      : groupBy === 'date'
      ? order.deliveryDate
      : order.outletName;

    if (!groupedOrders[key]) {
      groupedOrders[key] = { total: 0, items: [] };
    }

    groupedOrders[key].total += order.quantity;
    groupedOrders[key].items.push(order);
  });

  Object.entries(groupedOrders).forEach(([_, group]) => {
    group.items.sort((a, b) => a.outletName.localeCompare(b.outletName));
  });

  const sortedGroups = groupBy === 'date'
    ? Object.entries(groupedOrders).sort(
        ([a], [b]) => new Date(a) - new Date(b)
      )
    : Object.entries(groupedOrders);

  const handleMarkDelivered = async (orderId) => {
    try {
      await axios.put(`${API}/orders/${orderId}`, { status: 'delivered' });
      loadOrders();
    } catch (err) {
      console.error('Failed to update status');
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold text-center mb-6">Center Kitchen Dashboard</h1>

      <div className="flex flex-wrap justify-center gap-3 mb-6">
        {['sauce', 'date', 'outlet'].map(type => (
          <button
            key={type}
            onClick={() => setGroupBy(type)}
            className={`px-4 py-2 rounded ${
              groupBy === type
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </button>
        ))}
        <button
          onClick={() => setShowMaster(!showMaster)}
          className="px-4 py-2 rounded bg-yellow-500 text-white hover:bg-yellow-600"
        >
          {showMaster ? '>' : '<'}
        </button>
      </div>

      {!showMaster && sortedGroups.map(([groupName, data]) => (
        <div key={groupName} className="mb-4 bg-white rounded shadow p-4 border">
          <h3 className="text-lg font-semibold mb-2">{groupName}</h3>
          <ul className="text-sm text-gray-700 space-y-1">
            {data.items.map((item, index) => (
              <li key={index}>
                {groupBy !== 'outlet' && <strong>{item.outletName}</strong>}
                {groupBy !== 'outlet' && ' — '}
                {groupBy !== 'sauce' && <span>{item.sauce}</span>}
                {groupBy !== 'sauce' && ' — '}
                {item.quantity} kg
                {groupBy !== 'date' && ` (Delivery: ${item.deliveryDate})`}
                <button
                  className="ml-2 text-sm text-blue-600 underline"
                  onClick={() => handleMarkDelivered(item._id)}
                >
                  Mark Delivered
                </button>
              </li>
            ))}
          </ul>
          <div className="font-semibold mt-2">Total: {data.total} kg</div>
        </div>
      ))}

      {showMaster && (
        <div className="mt-10 border-t pt-6">
          <h2 className="text-lg font-bold mb-4">Manage Outlets & Sauces</h2>

          <div className="mb-6">
            <h3 className="font-semibold mb-2">Add Outlet</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await axios.post(`${API}/outlets`, { name: newOutlet });
                setNewOutlet('');
                loadOutlets();
              }}
              className="flex gap-2"
            >
              <input
                value={newOutlet}
                onChange={(e) => setNewOutlet(e.target.value)}
                placeholder="Outlet name"
                className="border p-2 rounded w-full"
              />
              <button className="bg-green-600 text-white px-4 rounded hover:bg-green-700">
                Add
              </button>
            </form>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Add Sauce</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await axios.post(`${API}/sauces`, {
                  sauceName: newSauce,
                  outletName: sauceOutlet,
                  standardWeightKg: sauceWeight,
                });
                setNewSauce('');
                setSauceOutlet('');
                setSauceWeight('');
              }}
              className="space-y-2"
            >
              <input
                value={newSauce}
                onChange={(e) => setNewSauce(e.target.value)}
                placeholder="Sauce name"
                className="border p-2 rounded w-full"
              />
              <input
                value={sauceWeight}
                onChange={(e) => setSauceWeight(e.target.value)}
                placeholder="Weight in kg"
                type="number"
                className="border p-2 rounded w-full"
              />
              <select
                value={sauceOutlet}
                onChange={(e) => setSauceOutlet(e.target.value)}
                className="border p-2 rounded w-full"
              >
                <option value="">Select Outlet</option>
                {outletList.map((outlet) => (
                  <option key={outlet._id} value={outlet.name}>
                    {outlet.name}
                  </option>
                ))}
              </select>
              <button className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                Add
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default CenterKitchen;
