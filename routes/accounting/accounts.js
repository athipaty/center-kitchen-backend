const express = require('express');
const router = express.Router();
const GlAccount = require('../../models/accounting/GlAccount');

const EXPRESS_ACCOUNTS = [
  { code: '1111-00', name: 'เงินสด', type: 'Asset' },
  { code: '1113-01', name: 'เงินฝากออมทรัพย์ K-bank 188-3-50387-9', type: 'Asset' },
  { code: '1113-02', name: 'เงินฝากออมทรัพย์ K-bank 318-92-0843-9', type: 'Asset' },
  { code: '1113-03', name: 'เงินฝากออมทรัพย์ ICBC 504-0-15069-4', type: 'Asset' },
  { code: '1130-01', name: 'ลูกหนี้การค้า', type: 'Asset' },
  { code: '1130-05', name: 'เงินประกันและเงินมัดจำ', type: 'Asset' },
  { code: '1140-01', name: 'วัตถุดิบคงเหลือ', type: 'Asset' },
  { code: '1140-02', name: 'สินค้าสำเร็จรูปคงเหลือ', type: 'Asset' },
  { code: '1151-01', name: 'ค่าใช้จ่ายจ่ายล่วงหน้า-ค่าสินค้า', type: 'Asset' },
  { code: '1151-02', name: 'ภาษีนิติบุคคลจ่ายล่วงหน้า', type: 'Asset' },
  { code: '1151-04', name: 'ค่าใช้จ่ายจ่ายล่วงหน้า-ค่าสอบบัญชี', type: 'Asset' },
  { code: '1151-05', name: 'ค่าใช้จ่ายจ่ายล่วงหน้า-อื่น ๆ', type: 'Asset' },
  { code: '1152-00', name: 'เงินทดรองจ่ายพนักงาน', type: 'Asset' },
  { code: '1154-00', name: 'ภาษีซื้อ', type: 'Asset' },
  { code: '1155-00', name: 'ภาษีซื้อ-ยังไม่ถึงกำหนด', type: 'Asset' },
  { code: '1156-00', name: 'ลูกหนี้-กรมสรรพากร', type: 'Asset' },
  { code: '1410-03', name: 'อุปกรณ์สำนักงาน', type: 'Asset' },
  { code: '1410-04', name: 'เครื่องตกแต่งสำนักงาน', type: 'Asset' },
  { code: '1410-06', name: 'สินทรัพย์ไม่มีตัวตน', type: 'Asset' },
  { code: '1410-07', name: 'เครื่องมือเครื่องใช้', type: 'Asset' },
  { code: '1420-03', name: 'ค่าเสื่อมราคาสะสม-อุปกรณ์สำนักงาน', type: 'Asset' },
  { code: '1420-04', name: 'ค่าเสื่อมราคาสะสม-เครื่องตกแต่งสำนักงาน', type: 'Asset' },
  { code: '1420-06', name: 'ค่าตัดจ่ายซอฟแวร์สะสม', type: 'Asset' },
  { code: '1420-07', name: 'ค่าเสื่อมราคาสะสม-เครื่องมือเครื่องใช้', type: 'Asset' },
  { code: '2120-01', name: 'เจ้าหนี้การค้า', type: 'Liability' },
  { code: '2131-01', name: 'เงินเดือนค้างจ่าย', type: 'Liability' },
  { code: '2131-04', name: 'เงินประกันสังคมรอนำส่ง', type: 'Liability' },
  { code: '2131-09', name: 'ค่าใช้จ่ายค้างจ่าย-อื่น ๆ', type: 'Liability' },
  { code: '2131-10', name: 'ค่าทำบัญชีค้างจ่าย', type: 'Liability' },
  { code: '2131-11', name: 'ค่าสอบบัญชีค้างจ่าย', type: 'Liability' },
  { code: '2132-01', name: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.1', type: 'Liability' },
  { code: '2132-03', name: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.3', type: 'Liability' },
  { code: '2132-04', name: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.53', type: 'Liability' },
  { code: '2133-01', name: 'รายได้รับล่วงหน้า-ค่าสินค้า', type: 'Liability' },
  { code: '2138-00', name: 'เงินกู้ยืมจากกรรมการ', type: 'Liability' },
  { code: '3300-00', name: 'กำไร(ขาดทุน)', type: 'Equity' },
  { code: '4200-04', name: 'กำไรจากอัตราแลกเปลี่ยน', type: 'Revenue' },
  { code: '4200-08', name: 'รายได้อื่น ๆ', type: 'Revenue' },
  { code: '5130-04', name: 'สติกเกอร์บรรจุภัณฑ์', type: 'Expense' },
  { code: '5130-05', name: 'ถังเหล็กบรรจุสินค้า', type: 'Expense' },
  { code: '5200-01', name: 'ค่านายหน้า/Commission', type: 'Expense' },
  { code: '5200-02', name: 'ค่าโฆษณา', type: 'Expense' },
  { code: '5200-05', name: 'ค่าขนส่ง', type: 'Expense' },
  { code: '5200-06', name: 'ค่ารับรอง', type: 'Expense' },
  { code: '5200-09', name: 'ค่าใช้จ่ายเดินทางและยานพาหนะ', type: 'Expense' },
  { code: '5200-11', name: 'ค่าใช้จ่ายในการนำเข้า-ส่งออก', type: 'Expense' },
  { code: '5310-01', name: 'เงินเดือน', type: 'Expense' },
  { code: '5310-02', name: 'ค่าล่วงเวลา', type: 'Expense' },
  { code: '5310-03', name: 'ค่าเบี้ยขยัน', type: 'Expense' },
  { code: '5310-05', name: 'เงินเพิ่มพิเศษ-เดินทาง+อาหาร', type: 'Expense' },
  { code: '5310-07', name: 'ค่าที่พักอาศัย', type: 'Expense' },
  { code: '5310-09', name: 'เงินสมทบกองทุนประกันสังคม', type: 'Expense' },
  { code: '5310-10', name: 'เงินสมทบกองทุนทดแทน', type: 'Expense' },
  { code: '5310-17', name: 'ค่าสวัสดิการอื่น ๆ', type: 'Expense' },
  { code: '5320-01', name: 'ค่าเครื่องเขียนแบบพิมพ์', type: 'Expense' },
  { code: '5320-03', name: 'วัสดุสิ้นเปลือง', type: 'Expense' },
  { code: '5320-05', name: 'ค่าเช่า', type: 'Expense' },
  { code: '5320-08', name: 'ค่าบริการ', type: 'Expense' },
  { code: '5330-01', name: 'ค่าโทรศัพท์', type: 'Expense' },
  { code: '5330-02', name: 'ค่าไฟฟ้า', type: 'Expense' },
  { code: '5330-03', name: 'ค่าน้ำประปา', type: 'Expense' },
  { code: '5330-04', name: 'ค่าไปรษณีย์', type: 'Expense' },
  { code: '5330-05', name: 'ค่าอินเตอร์เน็ต', type: 'Expense' },
  { code: '5340-03', name: 'ค่าเสื่อมราคา-อุปกรณ์สำนักงาน', type: 'Expense' },
  { code: '5340-04', name: 'ค่าเสื่อมราคา-เครื่องตกแต่งสำนักงาน', type: 'Expense' },
  { code: '5340-06', name: 'ค่าเสื่อมราคา-ซอฟแวร์', type: 'Expense' },
  { code: '5340-07', name: 'ค่าเสื่อมราคา-เครื่องมือเครื่องใช้', type: 'Expense' },
  { code: '5360-03', name: 'ภาษีป้าย', type: 'Expense' },
  { code: '5360-04', name: 'ค่าธรรมเนียมธนาคาร', type: 'Expense' },
  { code: '5360-07', name: 'ภาษีที่ดินและสิ่งปลูกสร้าง', type: 'Expense' },
  { code: '5360-08', name: 'ค่าธรรมเนียมอื่นๆ', type: 'Expense' },
  { code: '5360-10', name: 'ค่าทำบัญชี', type: 'Expense' },
  { code: '5370-06', name: 'ค่าใช้จ่ายเบ็ดเตล็ด', type: 'Expense' },
  { code: '5370-07', name: 'กำไรขาดทุนจากอัตราแลกเปลี่ยน', type: 'Expense' },
  { code: '5370-09', name: 'ค่าจ้างทำของ', type: 'Expense' },
  { code: '5370-10', name: 'ค่าน้ำมัน', type: 'Expense' },
  { code: '5390-02', name: 'ภาษีซื้อขอคืนไม่ได้', type: 'Expense' },
  { code: '5390-03', name: 'เบี้ยปรับเงินเพิ่ม', type: 'Expense' },
  { code: '5390-04', name: 'ค่าใช้จ่ายต้องห้าม-บิลไม่ครบ', type: 'Expense' },
  { code: '9999-99', name: 'บัญชีพัก', type: 'Other' },
];

router.get('/', async (req, res) => {
  try {
    const { company = 'Express' } = req.query;
    const accounts = await GlAccount.find({ company }).sort({ code: 1 });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed the Express company chart of accounts
router.post('/seed', async (req, res) => {
  try {
    const company = req.body.company || 'Express';
    await GlAccount.deleteMany({ company });
    await GlAccount.insertMany(EXPRESS_ACCOUNTS.map(a => ({ ...a, company })));
    res.json({ message: 'Seeded', count: EXPRESS_ACCOUNTS.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const account = new GlAccount(req.body);
    await account.save();
    res.status(201).json(account);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const account = await GlAccount.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(account);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await GlAccount.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
